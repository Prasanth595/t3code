// @effect-diagnostics nodeBuiltinImport:off - launcher integration with filesystem and fetch.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { flushTelemetry, observeSummaries, summarize } from "./launcher-telemetry.ts";

const task = (result: unknown) => ({
  package_name: "@team/server",
  task_name: "typecheck",
  command: "SECRET",
  cwd: "/private",
  result,
});

it("counts only confirmed hits, preserves their tier, and never transmits command text", () => {
  expect(
    summarize({
      tasks: [
        task({ CacheHit: { source: "Remote", saved_duration_ms: 1200 } }),
        task({ CacheHit: { source: "Local", saved_duration_ms: 500 } }),
        task({ RestoreFailed: {} }),
        task({ Spawned: {} }),
        task({ CacheHit: { saved_duration_ms: 999 } }),
        task({ CacheHit: { source: "Remote", saved_duration_ms: -1 } }),
      ],
    }),
  ).toEqual([
    { package: "@team/server", task: "typecheck", source: "remote", savedMs: 1200 },
    { package: "@team/server", task: "typecheck", source: "local", savedMs: 500 },
    { package: "@team/server", task: "typecheck", source: "failed", savedMs: 0 },
    { package: "@team/server", task: "typecheck", source: "executed", savedMs: 0 },
    { package: "@team/server", task: "typecheck", source: "unspecified", savedMs: 999 },
  ]);
});

it("deduplicates shared summaries and retries delivery without credentials in queued records", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cache-observer-"));
  const home = NodePath.join(root, "home");
  const endpoint = "https://cache.example/projects/t3code";
  try {
    const stopA = observeSummaries(root, endpoint, { T3_TASK_CACHE_HOST: "test-host" }, home);
    const stopB = observeSummaries(root, endpoint, { T3_TASK_CACHE_HOST: "test-host" }, home);
    const version = NodePath.join(root, "node_modules/.vite/task-cache/v18");
    NodeFS.mkdirSync(version);
    NodeFS.writeFileSync(
      NodePath.join(version, "last-summary.json"),
      JSON.stringify({
        tasks: [task({ CacheHit: { source: "Remote", saved_duration_ms: 1200 } })],
      }),
    );
    stopA();
    stopB();
    const queue = NodePath.join(home, ".cache/t3-task-cache/telemetry");
    const files = NodeFS.readdirSync(queue);
    expect(files).toHaveLength(1);
    const serialized = NodeFS.readFileSync(NodePath.join(queue, files[0]!), "utf8");
    expect(serialized).not.toContain("SECRET");
    expect(JSON.parse(serialized).event.host).toBe("test-host");
    NodeFS.mkdirSync(NodePath.join(home, ".config/t3-task-cache"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({ [endpoint]: { name: "alice", token: "secret-token" } }),
    );
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(async () => {
        const late = JSON.parse(serialized);
        late.event.id = "b".repeat(64);
        NodeFS.writeFileSync(NodePath.join(queue, "late.json"), JSON.stringify(late));
        return new Response(null, { status: 204 });
      })
      .mockResolvedValue(new Response(null, { status: 204 }));
    await flushTelemetry(home, {});
    expect(NodeFS.readdirSync(queue)).toEqual(files);
    await flushTelemetry(home, {});
    expect(NodeFS.readdirSync(queue)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]![0].toString()).toBe(`${endpoint}/telemetry`);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("skips an unauthenticated endpoint without blocking later queued events", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cache-queue-"));
  const endpoint = "https://cache.example/projects/t3code";
  try {
    const queue = NodePath.join(home, ".cache/t3-task-cache/telemetry");
    NodeFS.mkdirSync(queue, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(queue, "a.json"),
      JSON.stringify({ endpoint: "https://old.example/projects/t3code", event: { id: "old" } }),
    );
    NodeFS.writeFileSync(
      NodePath.join(queue, "b.json"),
      JSON.stringify({ endpoint, event: { id: "current" } }),
    );
    NodeFS.mkdirSync(NodePath.join(home, ".config/t3-task-cache"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({ [endpoint]: { name: "alice", token: "secret-token" } }),
    );
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await flushTelemetry(home, {});
    expect(NodeFS.readdirSync(queue)).toEqual(["a.json"]);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0].toString()).toBe(`${endpoint}/telemetry`);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
