import { MissionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { HostTransportBinding } from "../../../../packages/contracts/src/missionHostProtocol.ts";
import * as Combined from "../orchestration-v2/CombinedMissionRuntime.ts";
import * as Invocation from "./McpInvocationContext.ts";

class PeerFailure extends Schema.TaggedError<PeerFailure>()("MissionPeerMcpFailure", {
  code: Schema.Literals(["host_unavailable", "scope_denied", "handshake_failed"]),
}) {}

const Connect = Tool.make("mission_host_connect", {
  description:
    "Authenticate the explicitly configured No Fun peer channel for the current delivery manager. Requires approved peer pins, the existing environment signer, verified runtime inputs and an authenticated peer HTTP client. No defaults or caller-supplied peer facts. This handshake provides no execution fence or durable artifact ACK, never admits remote work, and makes no readiness claim.",
  parameters: Schema.Struct({ missionId: MissionId }),
  success: Schema.Struct({
    binding: HostTransportBinding,
    remoteExecutionPerformed: Schema.Literal(false),
  }),
  failure: PeerFailure,
  failureMode: "return",
  dependencies: [Invocation.McpInvocationContext, Combined.CombinedMissionRuntime],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Authenticate a mission peer channel");
const toolkit = Toolkit.make(Connect);
const handlers = toolkit.toLayer({
  mission_host_connect: (input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const runtime = yield* Combined.CombinedMissionRuntime;
      return yield* runtime
        .withRequest(
          scope,
          { missionId: input.missionId, role: "delivery" },
          (request) => request.connectHost,
        )
        .pipe(
          Effect.map((binding) => ({ binding, remoteExecutionPerformed: false as const })),
          Effect.mapError(
            (error) =>
              new PeerFailure({
                code:
                  error._tag === "CombinedMissionRuntimeError"
                    ? error.code === "host_unavailable"
                      ? "host_unavailable"
                      : "scope_denied"
                    : "handshake_failed",
              }),
          ),
        );
    }),
});

export const layerOptional = Layer.unwrap(
  Effect.serviceOption(Combined.CombinedMissionRuntime).pipe(
    Effect.map((runtime) =>
      Option.isNone(runtime)
        ? Layer.empty
        : McpServer.toolkit(toolkit).pipe(
            Layer.provide(handlers),
            Layer.provide(Layer.succeed(Combined.CombinedMissionRuntime, runtime.value)),
          ),
    ),
  ),
);
