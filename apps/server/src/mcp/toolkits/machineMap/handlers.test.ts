/** Fork: machine map agent tools (MM-801): what an agent hears when a call cannot go through. */
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as MachineMap from "../../../fork/machineMap/MachineMap.ts";
import * as MachinePeers from "../../../fork/machineMap/MachinePeers.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as MachineMapHandlers from "./handlers.ts";
import { MachineMapToolkit } from "./tools.ts";

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:machine-map-tools"),
  requestNamespace: "provider:machine-map-tools",
  thread: {
    threadId: ThreadId.make("thread:machine-map-tools"),
    providerSessionId: "provider:machine-map-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const machineCaller: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  requestNamespace: "machine-session:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "machine VPS", access: "full-access" },
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "machine-map", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "machine-map", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const callTool = (
  caller: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

const resultText = (result: { readonly content: ReadonlyArray<unknown> }) =>
  JSON.stringify(result.content);

const layerTools = McpHttpServer.toolkitRegistration(
  MachineMapToolkit,
  MachineMapHandlers.layer,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(liveThreadsLayer),
  Layer.provide(
    Layer.mock(MachineMap.MachineMap)({
      callMapTool: () =>
        Effect.fail(
          new MachineMap.MachineMapToolError({
            reason: "not-connected",
            detail: "This machine has no portal connection now.",
          }),
        ),
    }),
  ),
  Layer.provide(
    Layer.mock(MachinePeers.MachinePeers)({
      callTool: () =>
        Effect.fail(
          new MachinePeers.MachinePeerError({
            reason: "no-agent-tools",
            detail: "The arrow from this machine to VPS does not allow agent tools.",
          }),
        ),
    }),
  ),
);

it.effect("a map tool without a portal connection says so", () =>
  Effect.gen(function* () {
    const result = yield* callTool(threadCaller, "machines_read", {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("no portal connection");
  }).pipe(Effect.provide(layerTools)),
);

it.effect("machine_tool_call explains a missing agent tools arrow", () =>
  Effect.gen(function* () {
    const result = yield* callTool(threadCaller, "machine_tool_call", {
      machine: "vps",
      tool: "t3_thread_list",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("does not allow agent tools");
  }).pipe(Effect.provide(layerTools)),
);

it.effect("another machine cannot use the map tools of this machine", () =>
  Effect.gen(function* () {
    for (const [name, args] of [
      ["machines_read", {}],
      ["machine_tool_call", { machine: "mac", tool: "t3_thread_list" }],
    ] as const) {
      const result = yield* callTool(machineCaller, name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not available to another machine");
    }
  }).pipe(Effect.provide(layerTools)),
);
