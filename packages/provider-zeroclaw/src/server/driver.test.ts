// @effect-diagnostics nodeBuiltinImport:off -- Driver tests probe a fake daemon over a real socket.
import * as NodeFS from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { agentOptionDescriptor, probeZeroClaw } from "./driver.ts";

const withDaemon = <A, E>(use: (socketPath: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zc-driver-")),
    );
    const socketPath = NodePath.join(dir, "daemon.sock");
    const server = NodeNet.createServer((socket) => {
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length === 0) continue;
          const frame = JSON.parse(line) as {
            id?: string;
            method?: string;
            params?: { provider?: string };
          };
          if (frame.id === undefined || frame.method === undefined) continue;
          const result =
            frame.method === "initialize"
              ? { protocolVersion: 1 }
              : frame.method === "status"
                ? { version: "0.4.0" }
                : frame.method === "agents/list"
                  ? { agents: [{ alias: "coder" }, { alias: "reviewer" }] }
                  : frame.method === "config/catalog"
                    ? { providers: ["openai"] }
                    : frame.method === "config/catalog-models"
                      ? { models: ["gpt"] }
                      : {};
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
        }
      });
    });
    yield* Effect.callback<void>((resume) => {
      server.listen(socketPath, () => resume(Effect.void));
      return Effect.sync(() => server.close());
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => server.close()).pipe(
        Effect.andThen(Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true }))),
        Effect.ignore,
      ),
    );
    return yield* use(socketPath);
  }).pipe(Effect.scoped);

describe("probeZeroClaw", () => {
  it.live("returns a ready snapshot with models and does not open a session", () =>
    withDaemon((socketPath) =>
      Effect.gen(function* () {
        const snapshot = yield* probeZeroClaw({
          socketPath,
          instanceId: ProviderInstanceId.make("zc"),
          cache: { current: undefined },
        });
        expect(snapshot.status).toBe("ready");
        expect("models" in snapshot ? snapshot.models?.map((model) => model.slug) : []).toEqual([
          "default",
          "openai/gpt",
        ]);
        expect(agentOptionDescriptor(["coder", "reviewer"]).options).toEqual([
          { id: "coder", label: "coder" },
          { id: "reviewer", label: "reviewer" },
        ]);
      }),
    ),
  );

  it.effect("returns a warning snapshot when no socket is configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeZeroClaw({
        socketPath: "",
        instanceId: ProviderInstanceId.make("zc"),
        cache: { current: undefined },
      });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("zeroclaw daemon");
    }),
  );
});
