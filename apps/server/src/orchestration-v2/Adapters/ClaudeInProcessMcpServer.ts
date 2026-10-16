// @effect-diagnostics nodeBuiltinImport:off -- the stdio bridge reads a Node stream.
/* oxlint-disable unicorn/prefer-add-event-listener -- MCP transports take their handlers as properties. */
import * as NodeStream from "node:stream";

import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  McpSetServersResult,
} from "@anthropic-ai/claude-agent-sdk";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { runAcpMcpStdioBridge } from "../../mcp/AcpMcpStdioBridge.ts";

const T3_MCP_SERVER_NAME = "t3-code";

/** What the SDK passes to an in-process server's `connect`. */
interface SdkMcpTransport {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  send(message: unknown): Promise<void>;
}

/**
 * Serves an HTTP MCP endpoint to Claude Code as a server hosted in T3's
 * process. The stdio bridge relays the endpoint's JSON-RPC traffic verbatim,
 * so Claude sees the same tools, schemas, and results as over HTTP.
 */
export function inProcessMcpServer(input: {
  readonly name: string;
  readonly endpoint: string;
  readonly authorization: string;
  readonly timeout?: number;
  readonly context: Context.Context<never>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}): McpSdkServerConfigWithInstance {
  const runFork = Effect.runForkWith(input.context);
  const relay = {
    connect: async (transport: SdkMcpTransport) => {
      const requests = new NodeStream.PassThrough();
      const bridge = runFork(
        runAcpMcpStdioBridge({
          endpoint: input.endpoint,
          authorization: input.authorization,
          input: requests,
          output: {
            write: (line: string) => {
              transport.send(JSON.parse(line)).catch(() => undefined);
            },
          },
          ...(input.fetchImplementation === undefined
            ? {}
            : { fetchImplementation: input.fetchImplementation }),
        }),
      );
      transport.onmessage = (message) => {
        requests.write(`${JSON.stringify(message)}\n`);
      };
      // The bridge waits out in-flight calls when its input ends, and T3's
      // wait tools can run for an hour after the session is gone.
      transport.onclose = () => {
        requests.end();
        runFork(Fiber.interrupt(bridge));
      };
    },
  };
  return {
    type: "sdk",
    name: input.name,
    ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    // The SDK only ever calls `connect(transport)` on the instance.
    instance: relay as unknown as McpSdkServerConfigWithInstance["instance"],
  };
}

/**
 * Registers MCP servers over the CLI control channel and returns the names it
 * rejected. Claude Code's `allowedMcpServers` covers servers the CLI connects
 * to itself, not ones the SDK host serves, so when an allowlist rejects
 * `t3-code` over HTTP, T3 serves the same endpoint in-process instead.
 */
export const registerClaudeMcpServers = Effect.fn("registerClaudeMcpServers")(function* (input: {
  readonly servers: Record<string, McpServerConfig>;
  readonly setMcpServers: (
    servers: Record<string, McpServerConfig>,
  ) => Promise<McpSetServersResult>;
}) {
  const register = (servers: Record<string, McpServerConfig>) =>
    Effect.tryPromise(() => input.setMcpServers(servers)).pipe(
      Effect.map((result) => Object.keys(result.errors)),
      Effect.orElseSucceed(() => Object.keys(servers)),
    );
  const failed = yield* register(input.servers);
  const t3 = input.servers[T3_MCP_SERVER_NAME];
  const authorization = t3?.type === "http" ? t3.headers?.Authorization : undefined;
  if (!failed.includes(T3_MCP_SERVER_NAME) || t3?.type !== "http" || authorization === undefined) {
    return { failed, inProcess: false };
  }
  const retried = yield* register({
    ...input.servers,
    [T3_MCP_SERVER_NAME]: inProcessMcpServer({
      name: T3_MCP_SERVER_NAME,
      endpoint: t3.url,
      authorization,
      ...(t3.timeout === undefined ? {} : { timeout: t3.timeout }),
      context: yield* Effect.context<never>(),
    }),
  });
  return { failed: retried, inProcess: !retried.includes(T3_MCP_SERVER_NAME) };
});
