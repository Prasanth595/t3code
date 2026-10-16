import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { inProcessMcpServer, registerClaudeMcpServers } from "./ClaudeInProcessMcpServer.ts";

const t3Http = {
  type: "http",
  url: "http://127.0.0.1:1/mcp",
  headers: { Authorization: "Bearer session-token" },
  timeout: 3_900_000,
} as const;

const blocked = "Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)";

function recordingSetMcpServers(rejects: (name: string, config: McpServerConfig) => boolean) {
  const calls: Array<Record<string, McpServerConfig>> = [];
  return {
    calls,
    setMcpServers: async (servers: Record<string, McpServerConfig>) => {
      calls.push(servers);
      const errors: Record<string, string> = {};
      for (const [name, config] of Object.entries(servers)) {
        if (rejects(name, config)) errors[name] = blocked;
      }
      return { added: [], removed: [], errors };
    },
  };
}

describe("registerClaudeMcpServers", () => {
  it.effect("serves t3-code in-process when Claude Code rejects it over HTTP", () =>
    Effect.gen(function* () {
      const cli = recordingSetMcpServers((_name, config) => config.type === "http");
      const result = yield* registerClaudeMcpServers({
        servers: { "t3-code": t3Http },
        setMcpServers: cli.setMcpServers,
      });

      assert.deepEqual(result, { failed: [], inProcess: true });
      assert.equal(cli.calls.length, 2);
      const retried = cli.calls[1]?.["t3-code"];
      assert.equal(retried?.type, "sdk");
      assert.include(retried, { name: "t3-code", timeout: t3Http.timeout });
    }),
  );

  it.effect("keeps the HTTP registration when Claude Code accepts it", () =>
    Effect.gen(function* () {
      const cli = recordingSetMcpServers(() => false);
      const result = yield* registerClaudeMcpServers({
        servers: { "t3-code": t3Http },
        setMcpServers: cli.setMcpServers,
      });

      assert.deepEqual(result, { failed: [], inProcess: false });
      assert.deepEqual(cli.calls, [{ "t3-code": t3Http }]);
    }),
  );

  it.effect("reports t3-code as unavailable when the in-process server is rejected too", () =>
    Effect.gen(function* () {
      const cli = recordingSetMcpServers(() => true);
      const result = yield* registerClaudeMcpServers({
        servers: { "t3-code": t3Http },
        setMcpServers: cli.setMcpServers,
      });

      assert.deepEqual(result, { failed: ["t3-code"], inProcess: false });
    }),
  );
});

describe("inProcessMcpServer", () => {
  it.effect("relays Claude's JSON-RPC to the endpoint with the session credential", () =>
    Effect.gen(function* () {
      const authorizations: Array<string | null> = [];
      const server = inProcessMcpServer({
        name: "t3-code",
        endpoint: t3Http.url,
        authorization: t3Http.headers.Authorization,
        context: yield* Effect.context<never>(),
        fetchImplementation: async (_url, init) => {
          authorizations.push(new Headers(init?.headers).get("authorization"));
          const request = JSON.parse(String(init?.body)) as { readonly id?: unknown };
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: { tools: [{ name: "delegate_task", inputSchema: { type: "object" } }] },
          });
        },
      });

      const response = yield* Effect.promise(
        () =>
          new Promise<unknown>((resolve) => {
            const transport: {
              onmessage?: (message: unknown) => void;
              onclose?: () => void;
              send: (message: unknown) => Promise<void>;
            } = {
              send: async (message) => resolve(message),
            };
            const instance = server.instance as unknown as {
              connect: (transport: unknown) => Promise<void>;
            };
            void instance.connect(transport).then(() => {
              transport.onmessage?.({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
            });
          }),
      );

      assert.deepEqual(response, {
        jsonrpc: "2.0",
        id: 7,
        result: { tools: [{ name: "delegate_task", inputSchema: { type: "object" } }] },
      });
      assert.deepEqual(authorizations, ["Bearer session-token"]);
    }),
  );
});
