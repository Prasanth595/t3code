import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { cacheName } from "./resources.ts";

// Native summaries may be observed by nested launchers and retried after a lost response.
// Deduplicate before summing; task runtime is a compute proxy, not measured CPU or critical-path time.
export const savingsQuery = (
  dataset: string,
  group?: "developer" | "host" | "ci",
  lifetime = false,
) =>
  [
    `['${dataset}']`,
    `| where name == '${lifetime ? "TaskCache.lifetime" : "TaskCache.summary"}'`,
    `| extend a = ['attributes.custom']`,
    `| extend event_id = tostring(a['cache.event_id']), developer = tostring(a['developer.id']), host = tostring(['attributes.host.name']), ci = tobool(a['ci']), unspecified_ms = coalesce(tolong(a['cache.unspecified_saved_ms']), 0), unspecified_hits = coalesce(tolong(a['cache.unspecified_hits']), 0), local_ms = tolong(a['cache.local_saved_ms']), remote_ms = tolong(a['cache.remote_saved_ms']), local_hits = tolong(a['cache.local_hits']), remote_hits = tolong(a['cache.remote_hits']), executed = tolong(a['cache.executed']), restore_failures = tolong(a['cache.restore_failures'])`,
    `| summarize arg_max(_time, unspecified_ms, unspecified_hits, local_ms, remote_ms, local_hits, remote_hits, executed, restore_failures${lifetime ? "" : ", developer, host, ci"}) by ${lifetime ? "developer, host, ci, platform = tostring(a['host.os']), arch = tostring(['attributes.host.arch'])" : "event_id"}`,
    `| summarize saved_task_hours = sum(local_ms + remote_ms + unspecified_ms) / 3600000.0, remote_saved_hours = sum(remote_ms) / 3600000.0, local_saved_hours = sum(local_ms) / 3600000.0, unspecified_saved_hours = sum(unspecified_ms) / 3600000.0, unspecified_hits = sum(unspecified_hits), local_hits = sum(local_hits), remote_hits = sum(remote_hits), executed = sum(executed), restore_failures = sum(restore_failures)${group ? ` by ${group}` : ""}`,
  ].join("\n");

export const Observability = Effect.gen(function* () {
  const name = yield* cacheName;
  const traces = yield* Axiom.Dataset("CacheTraces", {
    name: `${name}-traces`,
    kind: "otel:traces:v1",
    description: "Shared task cache: service traces and unsampled native task savings reports.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });
  const token = yield* Axiom.ApiToken("CacheIngestToken", {
    name: `${name}-otel-ingest`,
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });
  const charts = [
    { id: "total", name: "Total avoided task runtime (hours)", group: undefined },
    { id: "developer", name: "Savings by developer", group: "developer" as const },
    { id: "host", name: "Savings by host", group: "host" as const },
    { id: "ci", name: "CI versus developer machines", group: "ci" as const },
  ];
  for (const chart of charts) {
    yield* Axiom.View(`CacheSavings-${chart.id}`, {
      name: `${name}-${chart.id}-savings`,
      description: chart.name,
      datasets: [traces.name],
      aplQuery: Output.map(traces.name, (dataset) => savingsQuery(dataset, chart.group, true)),
    });
  }
  const dashboard = yield* Axiom.Dashboard("CacheSavingsDashboard", {
    dashboard: {
      name: `${name}-savings`,
      owner: "",
      schemaVersion: 2,
      refreshTime: 60,
      description:
        "Avoided task execution time, not CPU seconds or elapsed developer time. Local and remote hits; deduplicated native Vite+ summaries. Lifetime counters are retained in D1 and refreshed hourly. Raw traces have 30-day retention.",
      timeWindowStart: "qr-now-30d",
      timeWindowEnd: "qr-now",
      charts: charts.map((chart) => ({
        id: chart.id,
        name: chart.name,
        type: "Table" as const,
        query: {
          apl: Output.map(traces.name, (dataset) => savingsQuery(dataset, chart.group, true)),
        },
      })),
      layout: charts.map((chart, index) => ({
        i: chart.id,
        x: (index % 2) * 6,
        y: Math.floor(index / 2) * 6,
        w: 6,
        h: 6,
      })),
    },
  });
  return { traces, token, dashboard };
});
