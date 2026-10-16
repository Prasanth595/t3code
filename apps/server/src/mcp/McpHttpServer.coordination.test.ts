import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit, McpServer, McpSchema } from "effect/ai";
import * as Coordination from "../coordination/CoordinationService.ts";
import * as Access from "./McpToolAccess.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { toolkitRegistration } from "./McpHttpServer.ts";

const toolkit = Toolkit.make(
  Tool.make("boundary_probe", {
    description: "Test a normal tool boundary.",
    parameters: Schema.Struct({ value: Schema.String }),
    success: Schema.Struct({ value: Schema.String }),
  }),
);
const handlers = Access.toLayer(toolkit, {
  boundary_probe: Access.reads((input) => Effect.succeed(input)),
});
const notice =
  "<project_coordination>Deployment request from another thread.</project_coordination>";
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "coordination-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "coordination-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("coordination-test"),
  requestNamespace: "coordination-test",
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId: ThreadId.make("recipient"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session",
  },
  client: undefined,
  issuedAt: 1,
};
const layer = toolkitRegistration(toolkit, handlers).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mock(Coordination.CoordinationService)({ toolNotice: () => Effect.succeed(notice) }),
  ),
);

it.effect(
  "delivers context in both tool result formats and keeps external clients unaffected",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (invocation: Invocation.McpInvocationScope) =>
          server
            .callTool({ name: "boundary_probe", arguments: { value: "normal result" } })
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const result = yield* call(scope);
        assert.deepEqual(result.structuredContent, {
          value: "normal result",
          projectCoordination: notice,
        });
        assert.isTrue(result.content.some((item) => item.type === "text" && item.text === notice));
        const external = yield* call({ ...scope, thread: undefined });
        assert.deepEqual(external.structuredContent, { value: "normal result" });
        assert.isFalse(
          external.content.some((item) => item.type === "text" && item.text === notice),
        );
      }).pipe(Effect.provide(layer)),
    ),
);
