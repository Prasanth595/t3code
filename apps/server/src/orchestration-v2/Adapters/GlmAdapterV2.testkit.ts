import * as NodeServices from "@effect/platform-node/NodeServices";
import { GlmSettings } from "@t3tools/provider-glm/settings";
import {
  GLM_DEFAULT_INSTANCE_ID,
  GLM_PROVIDER,
  makeGlmAdapterV2,
} from "@t3tools/provider-glm/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const REPLAY_SETTINGS = Schema.decodeSync(GlmSettings)({ enabled: true, authMethodId: "replay" });

function processTranscripts(transcript: AcpReplayTranscript) {
  const processes: Array<AcpReplayTranscript> = [];
  let start = 0;
  for (const [index, entry] of transcript.entries.entries()) {
    if (entry.type !== "runtime_exit") continue;
    processes.push({ ...transcript, entries: transcript.entries.slice(start, index + 1) });
    start = index + 1;
  }
  if (start !== transcript.entries.length || processes.length === 0) {
    throw new Error("GLM replay must record a runtime exit after every ACP process.");
  }
  return processes;
}

function layerGlmProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayDir = yield* fileSystem.makeTempDirectory({ prefix: "t3-glm-replay-" });
      const scriptPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      );
      const processes = processTranscripts(transcript);
      let processIndex = 0;
      const statusPath = (index: number) => path.join(replayDir, `process-${index}.json`);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (processIndex !== processes.length) {
            return yield* Effect.die(
              new Error("GLM replay did not start every recorded ACP process."),
            );
          }
          yield* Effect.forEach(
            processes,
            (recorded, index) =>
              makeAcpReplayCompletenessAssertion(fileSystem, statusPath(index), recorded),
            { discard: true },
          ).pipe(Effect.orDie);
        }),
      );
      const adapter = yield* makeGlmAdapterV2({
        instanceId: GLM_DEFAULT_INSTANCE_ID,
        settings: REPLAY_SETTINGS,
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (runtimeInput) =>
          Effect.suspend(() => {
            const index = processIndex++;
            const recorded = processes[index];
            if (recorded === undefined) {
              return Effect.fail(
                new EffectAcpErrors.AcpTransportError({
                  detail: "GLM replay started an unrecorded ACP process.",
                  cause: { processIndex: index, recordedProcesses: processes.length },
                }),
              );
            }
            return makeAcpReplayRuntime({
              transcript: recorded,
              statusPath: statusPath(index),
              scriptPath,
              childProcessSpawner,
              fileSystem,
              ...(options.replayGate === undefined ? {} : { replayGate: options.replayGate }),
            })(runtimeInput);
          }),
        assertComplete: Effect.suspend(() => {
          const index = processIndex - 1;
          const recorded = processes[index];
          if (recorded === undefined) {
            return Effect.fail(
              new EffectAcpErrors.AcpTransportError({
                detail: "GLM replay closed without a recorded ACP process.",
                cause: { processIndex, recordedProcesses: processes.length },
              }),
            );
          }
          return makeAcpReplayCompletenessAssertion(fileSystem, statusPath(index), recorded);
        }),
      });
      return [adapter];
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerHost,
        NodeServices.layer,
        IdAllocator.layer,
        Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
          resolve: () => Effect.die("GLM registry resolver must not run during replay"),
        }),
      ),
    ),
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
  return Layer.unwrap(
    Effect.map(Effect.scope, (scope) =>
      registry.pipe(Layer.provide(Layer.succeed(Scope.Scope, scope))),
    ),
  );
}

export const GlmOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: GLM_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, GLM_PROVIDER),
  makeProviderAdapterRegistryLayer: layerGlmProviderAdapterRegistryReplay,
};
