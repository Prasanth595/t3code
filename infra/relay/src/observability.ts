import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import { relayResourceNameForStage } from "./deploymentConfig.ts";

const relayRecentSpansQuery = (dataset: string) =>
  [
    `['${dataset}']`,
    `| where isnotnull(span_id) or isnotnull(trace_id)`,
    `| extend requestMethod = column_ifexists('attributes.http.request.method', ''), path = column_ifexists('attributes.url.path', ''), endpoint = column_ifexists('attributes.http.route', ''), statusCode = column_ifexists('attributes.http.response.status_code', 0), customAttributes = column_ifexists('attributes.custom', dynamic({}))`,
    `| extend userId = customAttributes['user']['id']`,
    `| project _time, name, trace_id, span_id, duration, requestMethod, path, statusCode, endpoint, userId`,
    `| order by _time desc`,
    `| limit 200`,
  ].join("\n");

// `/connect` answers 502 for every offline host (~150k/hour), so error counts
// leave it out. Status codes, not span errors: a request cut off by the relay
// deadline ends as an interrupted span with no error flag, but still a 504.
const serverSpans = (dataset: string) => `['${dataset}']\n| where kind == "server"`;

// Thresholds sit well above the busiest healthy 10-minute window of
// 2026-10-16..18 and far below the #16810 outage, which is noted per monitor.
interface RelayMonitor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly query: (dataset: string) => string;
  readonly operator: "AboveOrEqual" | "Below";
  readonly threshold: number;
  readonly alertOnNoData?: boolean;
  readonly triggerFromNRuns?: number;
}

const relayMonitors: ReadonlyArray<RelayMonitor> = [
  {
    id: "RelayCloudflareRateLimitedMonitor",
    name: "T3 Connect relay: Cloudflare API rate limited",
    description:
      "Cloudflare API 429s from tunnel and DNS provisioning. Healthy: ~0. #16810: thousands. Sustained 429s stall every link and tunnel recovery.",
    query: (dataset: string) =>
      `['${dataset}']\n| where ['attributes.url.full'] startswith "https://api.cloudflare.com" and ['attributes.http.response.status_code'] == 429\n| summarize rate_limited = count()`,
    operator: "AboveOrEqual",
    threshold: 200,
  },
  {
    id: "RelayLinkFailuresMonitor",
    name: "T3 Connect relay: environment link failures",
    description:
      "5xx from POST /v1/client/environment-links (turning on T3 Connect). Healthy: median 6, max 45. #16810: 250-500.",
    query: (dataset: string) =>
      `${serverSpans(dataset)} and ['attributes.http.route'] == "/v1/client/environment-links" and ['attributes.http.request.method'] == "POST" and ['attributes.http.response.status_code'] >= 500\n| summarize failed_links = count()`,
    operator: "AboveOrEqual",
    threshold: 100,
  },
  {
    id: "RelayTunnelRecoveryFailuresMonitor",
    name: "T3 Connect relay: tunnel recovery failures",
    description:
      "5xx from host tunnel recovery and registration, including relay deadline 504s. Healthy: median 42, max 272. #16810: 4k-9k.",
    query: (dataset: string) =>
      `${serverSpans(dataset)} and ['attributes.http.route'] in ("/v1/environments/:environmentId/tunnel", "/v1/environments/:environmentId/tunnel/recovery") and ['attributes.http.response.status_code'] >= 500\n| summarize failed_recoveries = count()`,
    operator: "AboveOrEqual",
    threshold: 1000,
  },
  {
    id: "RelayServerErrorsMonitor",
    name: "T3 Connect relay: elevated 5xx",
    description:
      "All relay 5xx except /connect 502s for offline hosts. Healthy: median ~210, max ~510. #16810: 5k-10k.",
    query: (dataset: string) =>
      `${serverSpans(dataset)} and ['attributes.http.response.status_code'] >= 500\n| where not(['attributes.http.route'] == "/v1/environments/:environmentId/connect" and ['attributes.http.response.status_code'] == 502)\n| summarize server_errors = count()`,
    operator: "AboveOrEqual",
    threshold: 2000,
  },
  {
    id: "RelayTrafficDroppedMonitor",
    name: "T3 Connect relay: traffic dropped",
    description:
      "Relay request volume collapsed: Worker down, broken deploy, or trace export stopped. Healthy minimum: ~69k per 10 minutes.",
    query: (dataset: string) => `${serverSpans(dataset)}\n| summarize requests = count()`,
    operator: "Below",
    threshold: 10_000,
    alertOnNoData: true,
    triggerFromNRuns: 2,
  },
];

export const RelayObservability = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const traces = yield* Axiom.Dataset("RelayTracesDataset", {
    name: relayResourceNameForStage("t3-code-relay-traces", stage),
    kind: "otel:traces:v1",
    description: "T3 Code relay Worker HTTP request spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const workerIngestToken = yield* Axiom.ApiToken("RelayWorkerAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-relay-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for relay HTTP spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  const mobileIngestToken = yield* Axiom.ApiToken("RelayMobileAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-mobile-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for T3 Code mobile spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  const clientIngestToken = yield* Axiom.ApiToken("RelayClientAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-relay-client-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for first-party relay client spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  yield* Axiom.View("RelayRecentSpansView", {
    name: relayResourceNameForStage("t3-code-relay-recent-spans", stage),
    description: "Recent relay HTTP request spans.",
    datasets: [traces.name],
    aplQuery: Output.map(traces.name, relayRecentSpansQuery),
  });

  // Personal stages and forks leave this unset, so only a deployment that
  // names a notifier (incident.io for prod) gets monitors that can page.
  const alertNotifierId = yield* Config.String("RELAY_ALERT_NOTIFIER_ID").pipe(
    Config.option,
    Config.map(Option.flatMap((value) => Option.liftPredicate(value.trim(), Boolean))),
  );
  if (Option.isSome(alertNotifierId)) {
    for (const monitor of relayMonitors) {
      yield* Axiom.Monitor(monitor.id, {
        name: stage === "prod" ? monitor.name : `[${stage}] ${monitor.name}`,
        description: monitor.description,
        type: "Threshold",
        aplQuery: Output.map(traces.name, monitor.query),
        operator: monitor.operator,
        threshold: monitor.threshold,
        intervalMinutes: 5,
        rangeMinutes: 10,
        triggerFromNRuns: monitor.triggerFromNRuns ?? 1,
        alertOnNoData: monitor.alertOnNoData ?? false,
        notifierIds: [alertNotifierId.value],
      });
    }
  }

  return { traces, workerIngestToken, mobileIngestToken, clientIngestToken } as const;
});

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

const appendEncodedAttributes = (
  attributes: Record<string, unknown>,
  prefix: string,
  value: unknown,
): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    Array.isArray(value)
  ) {
    attributes[prefix] = value;
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    appendEncodedAttributes(attributes, `${prefix}.${key}`, child);
  }
};

const schemaErrorAttributes = (error: unknown): Record<string, unknown> | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const constructor = error.constructor;
  if (!Schema.isSchema(constructor)) {
    return undefined;
  }
  const encoded = Schema.encodeUnknownOption(constructor as unknown as Schema.Encoder<unknown>)(
    error,
  );
  if (Option.isNone(encoded) || typeof encoded.value !== "object" || encoded.value === null) {
    return undefined;
  }
  const tag = Reflect.get(encoded.value, "_tag");
  if (typeof tag !== "string") {
    return undefined;
  }

  const attributes: Record<string, unknown> = {
    "error.type": tag,
  };
  for (const [key, value] of Object.entries(encoded.value)) {
    if (key !== "_tag") {
      appendEncodedAttributes(attributes, `error.${key}`, value);
    }
  }
  return attributes;
};

const annotateSchemaError = (span: Tracer.Span, exit: Exit.Exit<unknown, unknown>): void => {
  if (Exit.isSuccess(exit)) {
    return;
  }
  for (const reason of exit.cause.reasons) {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    const attributes = schemaErrorAttributes(error);
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        span.attribute(key, value);
      }
      return;
    }
  }
};

class RelayTraceSpan implements Tracer.Span {
  readonly _tag = "Span";
  private readonly delegate: Tracer.Span;

  constructor(delegate: Tracer.Span) {
    this.delegate = delegate;
  }

  get name() {
    return this.delegate.name;
  }
  get spanId() {
    return this.delegate.spanId;
  }
  get traceId() {
    return this.delegate.traceId;
  }
  get parent() {
    return this.delegate.parent;
  }
  get annotations() {
    return this.delegate.annotations;
  }
  get status() {
    return this.delegate.status;
  }
  get attributes() {
    return this.delegate.attributes;
  }
  get links() {
    return this.delegate.links;
  }
  get sampled() {
    return this.delegate.sampled;
  }
  get kind() {
    return this.delegate.kind;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    annotateSchemaError(this.delegate, exit);
    this.delegate.end(endTime, exit);
  }

  attribute(key: string, value: unknown): void {
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.delegate.event(name, startTime, attributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.delegate.addLinks(links);
  }
}

const withSchemaErrorAttributes = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => new RelayTraceSpan(delegate.span(options)),
    ...(delegate.context ? { context: delegate.context } : {}),
  });

export const withSchemaErrorSpanAttributes = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.tracer, (tracer) =>
    effect.pipe(Effect.withTracer(withSchemaErrorAttributes(tracer))),
  );
