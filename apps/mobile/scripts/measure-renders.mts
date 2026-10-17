// Measures React renders in a running T3 Code Dev client. See
// docs/internals/mobile-development.md#measuring-renders.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ShellSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const RenderReport = Schema.Struct({
  commits: Schema.Number,
  totalRenders: Schema.Number,
  components: Schema.Array(
    Schema.Struct({ name: Schema.String, region: Schema.String, renders: Schema.Number }),
  ),
  causes: Schema.Array(Schema.Struct({ key: Schema.String, count: Schema.Number })),
});
type RenderReport = typeof RenderReport.Type;
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(RenderReport));
const InspectorTargets = Schema.Array(
  Schema.Struct({ appId: Schema.String, webSocketDebuggerUrl: Schema.String }),
);
const CdpReply = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(
    Schema.Struct({
      result: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
      exceptionDetails: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeCdpReply = Schema.decodeUnknownOption(Schema.fromJsonString(CdpReply));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class MeasureError extends Schema.TaggedError<MeasureError>()("MeasureError", {
  message: Schema.String,
}) {}

// The component name that roots each region; everything else counts as "other".
const REGION_ROOTS = {
  ThreadFeed: "feed",
  ThreadComposer: "composer",
  ThreadHeader: "header",
};
const REGIONS = ["feed", "composer", "header", "other"] as const;
const STREAM_PROMPT =
  "Think it through step by step, then write a 3000-word essay on the history of typesetting in plain paragraphs with a few headings. Do not use any tools.";

interface Options {
  readonly server: string;
  readonly token: string;
  readonly metro: string;
  readonly scheme: string;
  readonly runs: number;
  readonly windowSeconds: number;
  readonly provider: string;
  readonly model: string;
  readonly projectRoot: string;
}

const uuid = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4());

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** One Hermes inspector session, reached through Metro's inspector proxy. */
const connectInspector = Effect.fn("measure.connectInspector")(function* (metro: string) {
  const http = yield* HttpClient.HttpClient;
  const targets = yield* http
    .get(`${metro}/json/list`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(InspectorTargets)));
  const target = targets.find((entry) => entry.appId.startsWith("com.t3tools.t3code"));
  if (!target)
    return yield* new MeasureError({ message: `No T3 Code app is attached to Metro at ${metro}.` });
  // Expo terminates inspector sockets whose Origin differs from the URL Metro
  // advertises (the LAN address with `--lan`), so pass that URL as `--metro`.
  const socket = yield* Socket.makeWebSocket(target.webSocketDebuggerUrl, {
    headers: { origin: new URL(metro).origin },
    openTimeout: "10 seconds",
  });
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  let nextId = 0;
  return Effect.fn("measure.evaluate")(function* (expression: string) {
    const id = ++nextId;
    yield* writer.write(
      encodeJson({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
    );
    while (true) {
      for (const frame of yield* reader.pull) {
        const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
        const reply = decodeCdpReply(text);
        if (Option.isNone(reply) || reply.value.id !== id) continue;
        if (reply.value.result?.exceptionDetails)
          return yield* new MeasureError({
            message: `Evaluation failed: ${encodeJson(reply.value.result.exceptionDetails)}`,
          });
        return reply.value.result?.result?.value;
      }
    }
  });
});

const connectServer = Effect.fn("measure.connectServer")(function* (options: Options) {
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.bearerToken(options.token),
        HttpClientRequest.setHeader(
          ORCHESTRATION_PROTOCOL_HEADER,
          String(ORCHESTRATION_PROTOCOL_VERSION),
        ),
      ),
    ),
    HttpClient.filterStatusOk,
  );
  const descriptor = yield* http
    .get(`${options.server}/.well-known/t3/environment`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)));
  const shell = yield* http
    .get(`${options.server}/api/orchestration/shell`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(OrchestrationV2ShellSnapshot)));
  let projectId = shell.projects.find(
    (project) => project.workspaceRoot === options.projectRoot,
  )?.id;
  // A project record outlives its folder, and turns fail without it.
  yield* (yield* FileSystem.FileSystem).makeDirectory(options.projectRoot, { recursive: true });
  if (!projectId) {
    projectId = ProjectId.make(yield* uuid);
    yield* http.execute(
      HttpClientRequest.post(`${options.server}/api/projects/mutate`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          type: "project.create",
          commandId: yield* uuid,
          projectId,
          title: "Render measurement",
          workspaceRoot: options.projectRoot,
        }),
      ),
    );
  }
  const ticket = yield* http
    .execute(HttpClientRequest.post(`${options.server}/api/auth/websocket-ticket`))
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
    );
  // Built into the caller's scope: `Effect.provide` would close the socket once `make` returns.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${options.server.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  return { client, environmentId: EnvironmentId.make(descriptor.environmentId), projectId };
});

// Streaming lands in turn items. Some providers stream reasoning but deliver the
// reply text in one piece, so any streaming text item counts as mid-stream.
const streamingItem = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems.find(
    (item) => (item.type === "assistant_message" || item.type === "reasoning") && item.streaming,
  );

/** Scenario `stream-reply`: an open thread streams a long reply while the composer is idle. */
const measureStreamReply = Effect.fn("measure.streamReply")(function* (
  options: Options,
  run: number,
) {
  const evaluate = yield* connectInspector(options.metro);
  const { client, environmentId, projectId } = yield* connectServer(options);
  const threadId = ThreadId.make(yield* uuid);
  yield* client["orchestration.launchThread"]({
    commandId: CommandId.make(yield* uuid),
    threadId,
    projectId,
    title: `Render measurement ${run}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make(options.provider),
      model: options.model,
    },
    // The prompt needs no tools; approval-required keeps a stray call from acting.
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: STREAM_PROMPT, attachments: [] },
  });
  // A failed or interrupted window must not leave a provider turn running.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const after = yield* client["orchestration.getThreadProjection"]({ threadId });
      const activeRun = after.runs.find(
        (entry) => !["completed", "failed", "interrupted", "cancelled"].includes(entry.status),
      );
      if (!activeRun) return;
      yield* client["orchestration.dispatchCommand"]({
        type: "run.interrupt",
        commandId: CommandId.make(yield* uuid),
        threadId,
        runId: activeRun.id,
      });
    }).pipe(Effect.ignore),
  );
  yield* evaluate(
    `__t3RenderCounterOpen(${encodeJson(`${options.scheme}://threads/${environmentId}/${threadId}`)})`,
  );
  const projectionOf = (item: { kind: string; projection?: OrchestrationV2ThreadProjection }) =>
    item.kind === "snapshot" && item.projection
      ? Effect.succeed(item.projection)
      : client["orchestration.getThreadProjection"]({ threadId });
  const streaming = yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
    Stream.mapEffect(projectionOf),
    Stream.filter((projection) => streamingItem(projection) !== undefined),
    Stream.runHead,
    Effect.timeout("90 seconds"),
  );
  if (Option.isNone(streaming))
    return yield* new MeasureError({ message: `Run ${run}: the reply never started streaming.` });
  yield* evaluate(`__t3RenderCounterStart(${encodeJson(REGION_ROOTS)})`);
  yield* Effect.sleep(`${options.windowSeconds} seconds`);
  const report = yield* decodeReport(yield* evaluate("JSON.stringify(__t3RenderCounterStop())"));
  // React commits on every streamed delta, so an empty window means the app is not on the thread.
  if (report.commits === 0)
    return yield* new MeasureError({
      message: `Run ${run}: no React commits in the window. Check the device for a red box.`,
    });
  const after = yield* client["orchestration.getThreadProjection"]({ threadId });
  return { report, stillStreaming: streamingItem(after) !== undefined };
}, Effect.scoped);

const formatTable = (reports: ReadonlyArray<RenderReport>) => {
  const lines: string[] = [];
  const regionTotal = (report: RenderReport, region: string) =>
    report.components
      .filter((entry) => entry.region === region)
      .reduce((total, entry) => total + entry.renders, 0);
  lines.push(`Median of ${reports.length} runs.`, "", "| Region | Renders |", "|---|---:|");
  for (const region of REGIONS)
    lines.push(`| ${region} | ${median(reports.map((report) => regionTotal(report, region)))} |`);
  lines.push(`| **total** | **${median(reports.map((report) => report.totalRenders))}** |`);
  lines.push(`| commits | ${median(reports.map((report) => report.commits))} |`);
  // Provider pace sets how many commits land in the window; per-commit cost is comparable across runs.
  lines.push(
    `| renders per commit | ${median(reports.map((report) => Math.round(report.totalRenders / Math.max(report.commits, 1))))} |`,
  );

  const componentKeys = new Map<string, { name: string; region: string }>();
  for (const report of reports)
    for (const entry of report.components)
      componentKeys.set(`${entry.region}/${entry.name}`, {
        name: entry.name,
        region: entry.region,
      });
  const componentRows = [...componentKeys.values()]
    .map(({ name, region }) => ({
      name,
      region,
      renders: median(
        reports.map(
          (report) =>
            report.components.find((entry) => entry.name === name && entry.region === region)
              ?.renders ?? 0,
        ),
      ),
    }))
    .filter((entry) => entry.renders > 0)
    .sort((a, b) => b.renders - a.renders)
    .slice(0, 25);
  lines.push("", "| Component | Region | Renders |", "|---|---|---:|");
  for (const row of componentRows) lines.push(`| ${row.name} | ${row.region} | ${row.renders} |`);

  const causes = new Set(reports.flatMap((report) => report.causes.map((entry) => entry.key)));
  const causeRows = [...causes]
    .map((key) => ({
      key,
      count: median(
        reports.map((report) => report.causes.find((entry) => entry.key === key)?.count ?? 0),
      ),
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  lines.push("", "| Top causes | Count |", "|---|---:|");
  for (const row of causeRows) lines.push(`| \`${row.key}\` | ${row.count} |`);
  return lines.join("\n");
};

const command = Command.make(
  "measure-renders",
  {
    scenario: Flag.Literals("scenario", ["stream-reply"]).pipe(Flag.withDefault("stream-reply")),
    server: Flag.String("server").pipe(
      Flag.withDescription("T3 server origin the app is paired with."),
    ),
    token: Flag.String("token").pipe(
      Flag.withDescription("Bearer token from `t3 auth session issue --token-only`."),
    ),
    metro: Flag.String("metro").pipe(Flag.withDefault("http://127.0.0.1:8081")),
    scheme: Flag.String("scheme").pipe(Flag.withDefault("t3code-dev")),
    runs: Flag.Int("runs").pipe(Flag.withDefault(3)),
    window: Flag.Int("window").pipe(Flag.withDefault(12)),
    provider: Flag.String("provider").pipe(Flag.withDefault("claudeAgent")),
    model: Flag.String("model").pipe(Flag.withDefault("claude-haiku-5-5")),
    projectRoot: Flag.String("project-root").pipe(
      Flag.withDescription("Scratch directory for the measurement project; created if missing."),
    ),
    json: Flag.String("json").pipe(Flag.optional),
  },
  Effect.fn("measure.main")(function* (flags) {
    const options: Options = { ...flags, windowSeconds: flags.window };
    const reports: RenderReport[] = [];
    for (let run = 1; run <= flags.runs; run++) {
      const { report, stillStreaming } = yield* measureStreamReply(options, run);
      yield* Console.error(
        `run ${run}: ${report.totalRenders} renders in ${report.commits} commits${stillStreaming ? "" : " (warning: streaming ended inside the window)"}`,
      );
      reports.push(report);
      // Let the interrupted turn settle so the next run starts from a quiet app.
      yield* Effect.sleep("3 seconds");
    }
    if (Option.isSome(flags.json))
      yield* (yield* FileSystem.FileSystem).writeFileString(flags.json.value, encodeJson(reports));
    yield* Console.log(formatTable(reports));
  }),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocketConstructorWS,
    ),
  ),
  NodeRuntime.runMain,
);
