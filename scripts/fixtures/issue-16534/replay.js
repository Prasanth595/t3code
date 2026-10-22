/** Capture-only protocol fixture. Install before modules; never import in product code.
 * Pass options through sessionStorage sidebar-capture-config.replay. Real server
 * frames still travel through the real RPC decoder and client reducers.
 */
(() => {
  const options = JSON.parse(sessionStorage.getItem("sidebar-capture-config") || "{}").replay || {};
  const NativeWebSocket = WebSocket;
  const held = [];
  globalThis.__sidebarWire = [];
  const frames = [];
  globalThis.__sidebarReplay = {
    frames,
    held,
    release() {
      if (delayedThread && shellSocket && shellRequestId !== null) {
        shellSocket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              _tag: "Chunk",
              requestId: shellRequestId,
              values: [
                {
                  kind: "thread.updated",
                  sequence: shellSequence + 1,
                  location: "active",
                  thread: delayedThread,
                },
              ],
            }),
          }),
        );
        delayedThread = null;
      }
      for (const run of held.splice(0)) run();
    },
  };

  let delayedThread = null;
  let shellSocket = null;
  let shellRequestId = null;
  let shellSequence = 0;
  const transformSnapshot = (snapshot) => {
    snapshot.threads = snapshot.threads.filter(
      (t) =>
        t.id.startsWith("triage-") && (options.lineage || !/^triage-A-(9|10|11|12)$/.test(t.id)),
    );
    snapshot.projects = snapshot.projects?.filter((p) => p.id?.startsWith("triage-")) || [];
    shellSequence = snapshot.snapshotSequence;
    if (options.delay) {
      delayedThread = snapshot.threads.find((t) => t.id === "triage-A-1");
      snapshot.threads = snapshot.threads.filter((t) => t.id !== "triage-A-1");
    }
    for (const thread of snapshot.threads) {
      if (thread.id === "triage-A-1" && options.shelf) {
        Object.assign(thread, {
          pinnedAt: null,
          snoozedUntil: null,
          settledOverride: null,
          settledAt: null,
        });
        if (options.shelf === "pinned")
          Object.assign(thread, { pinnedAt: "2026-10-22T00:00:00.000Z", pinOrderKey: "a0" });
        if (options.shelf === "snoozed")
          Object.assign(thread, {
            snoozedUntil: "2099-01-01T00:00:00.000Z",
            snoozedAt: "2026-10-22T00:00:00.000Z",
          });
        if (options.shelf === "working")
          Object.assign(thread, {
            status: "running",
            activeRunId: "triage-run-working",
            latestRunId: "triage-run-working",
            activityRunStatus: "running",
            latestRunRequestedAt: "2026-10-21T23:00:00.000Z",
            latestRunStartedAt: "2026-10-21T23:00:00.000Z",
          });
      }
      if (options.shelf === "settled" && thread.projectId === "triage-project-A") {
        Object.assign(thread, { settledOverride: "settled", settledAt: thread.createdAt });
      }
      if (options.status && ["triage-A-1", "triage-A-2"].includes(thread.id)) {
        Object.assign(thread, {
          status: thread.id === "triage-A-1" ? "failed" : "completed",
          latestRunId: "triage-run-" + thread.id,
          latestRunRequestedAt: "2026-10-21T23:00:00.000Z",
          latestRunCompletedAt: "2026-10-21T23:01:00.000Z",
          lastVisitedAt: null,
        });
      }
    }
    return snapshot;
  };
  const nativeFetch = fetch;
  globalThis.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = String(args[0]?.url ?? args[0]);
    if (!options.enabled || !url.includes("/api/orchestration/shell") || !response.ok)
      return response;
    const value = await response.clone().json();
    if (!Array.isArray(value.threads)) return response;
    frames.push({
      kind: "http.shell",
      count: value.threads.length,
      sequence: value.snapshotSequence,
    });
    transformSnapshot(value);
    return new Response(JSON.stringify(value), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };

  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      let replaying = false;
      this.addEventListener("message", (event) => {
        if (replaying) return;
        frames.push({
          kind: "frame",
          type: typeof event.data,
          constructor: event.data?.constructor?.name,
          length: event.data?.length,
        });
        if (typeof event.data !== "string") return;
        let value;
        let ndjson = false;
        try {
          value = JSON.parse(event.data);
        } catch {
          try {
            value = event.data
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            ndjson = true;
          } catch {
            frames.push({ kind: "unparsed", length: event.data.length });
            return;
          }
        }
        globalThis.__sidebarWire.push(value);
        if (
          value._tag === "Chunk" &&
          value.values?.some(
            (x) => x?.kind === "synchronized" || (x?.kind === "snapshot" && x.snapshot?.threads),
          )
        ) {
          shellSocket = this;
          shellRequestId = value.requestId;
        }
        frames.push({
          kind: "parsed",
          tag: value?._tag,
          keys: Object.keys(value || {}),
          count: Array.isArray(value) ? value.length : undefined,
        });
        let changed = false;
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          if (node.kind === "snapshot" && node.snapshot && Array.isArray(node.snapshot.threads)) {
            const snapshot = node.snapshot;
            frames.push({
              kind: "shell.snapshot",
              count: snapshot.threads.length,
              sequence: snapshot.snapshotSequence,
            });
            snapshot.threads = snapshot.threads.filter(
              (t) =>
                t.id.startsWith("triage-") &&
                (options.lineage || !/^triage-A-(9|10|11|12)$/.test(t.id)),
            );
            changed = true;
            const target = snapshot.threads.find((t) => t.id === "triage-A-1");
            if (options.delay && target) {
              snapshot.threads = snapshot.threads.filter((t) => t !== target);
              const original = JSON.parse(JSON.stringify(value));
              const replace = (n) => {
                if (!n || typeof n !== "object") return;
                if (n.kind === "snapshot" && n.snapshot && Array.isArray(n.snapshot.threads)) {
                  delete n.snapshot;
                  n.kind = "thread.updated";
                  n.sequence = snapshot.snapshotSequence + 1;
                  n.location = "active";
                  n.thread = target;
                } else Object.values(n).forEach(replace);
              };
              replace(original);
              held.push(() => deliver(original));
              changed = true;
            }
            for (const thread of snapshot.threads) {
              if (thread.id === "triage-A-1" && options.shelf) {
                Object.assign(thread, {
                  pinnedAt: null,
                  snoozedUntil: null,
                  settledOverride: null,
                  settledAt: null,
                });
                if (options.shelf === "pinned")
                  Object.assign(thread, {
                    pinnedAt: "2026-10-22T00:00:00.000Z",
                    pinOrderKey: "a0",
                  });
                if (options.shelf === "snoozed")
                  Object.assign(thread, {
                    snoozedUntil: "2099-01-01T00:00:00.000Z",
                    snoozedAt: "2026-10-22T00:00:00.000Z",
                  });
                if (options.shelf === "working")
                  Object.assign(thread, {
                    status: "running",
                    activeRunId: "triage-run-working",
                    latestRunId: "triage-run-working",
                    activityRunStatus: "running",
                    latestRunRequestedAt: "2026-10-21T23:00:00.000Z",
                    latestRunStartedAt: "2026-10-21T23:00:00.000Z",
                  });
                changed = true;
              }
              if (options.shelf === "settled" && thread.projectId === "triage-project-A") {
                Object.assign(thread, { settledOverride: "settled", settledAt: thread.createdAt });
                changed = true;
              }
              if (options.status && ["triage-A-1", "triage-A-2"].includes(thread.id)) {
                Object.assign(thread, {
                  status: thread.id === "triage-A-1" ? "failed" : "completed",
                  latestRunId: "triage-run-" + thread.id,
                  latestRunRequestedAt: "2026-10-21T23:00:00.000Z",
                  latestRunCompletedAt: "2026-10-21T23:01:00.000Z",
                  lastVisitedAt: null,
                });
                changed = true;
              }
            }
          }
          Object.values(node).forEach((v) => {
            if (v && typeof v === "object") Array.isArray(v) ? v.forEach(visit) : visit(v);
          });
        };
        const deliver = (data) => {
          replaying = true;
          try {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: ndjson
                  ? data.map((item) => JSON.stringify(item)).join("\n") + "\n"
                  : JSON.stringify(data),
              }),
            );
          } finally {
            replaying = false;
          }
        };
        visit(value);
        if (changed) {
          event.stopImmediatePropagation();
          deliver(value);
        }
      });
    }
  };
})();
