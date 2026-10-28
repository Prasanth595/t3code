import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

export class CodexReplayTranscriptDecodeError extends Schema.TaggedError<CodexReplayTranscriptDecodeError>()(
  "CodexReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Codex app-server replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export const CodexOrchestratorReplayHarnessError = Schema.Union([
  CodexReplayTranscriptDecodeError,
  CodexReplay.CodexAppServerReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CodexOrchestratorReplayHarnessError = typeof CodexOrchestratorReplayHarnessError.Type;

export function withCodexReplayChildMetadata(
  client: CodexClient.CodexAppServerClient["Service"],
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  readMetadata: (
    threadId: string,
    method: "thread/read" | "thread/resume",
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError> = (threadId) =>
    Effect.succeed({ thread: { id: threadId }, model: null }),
): CodexClient.CodexAppServerClient["Service"] {
  const childThreadIds = new Set(
    transcript.entries.flatMap((entry) => {
      if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) return [];
      const params = entry.frame.params;
      if (!Predicate.isObject(params) || !Predicate.isObject(params.item)) return [];
      const item = params.item;
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
        return [item.agentThreadId];
      }
      return item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter(Predicate.isString)
        : [];
    }),
  );
  return {
    ...client,
    raw: {
      ...client.raw,
      request: (method, params) =>
        (method === "thread/read" || method === "thread/resume") &&
        Predicate.isObject(params) &&
        (method === "thread/read" ? params.includeTurns === false : params.excludeTurns === true) &&
        typeof params.threadId === "string" &&
        childThreadIds.has(params.threadId)
          ? readMetadata(params.threadId, method)
          : client.raw.request(method, params),
    },
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

/** Serves recorded app-server connections to the sessions a replay test opens. */
export const makeReplayClientFactory = Effect.fn("CodexAdapterV2Testkit.makeReplayClientFactory")(
  function* (input: {
    readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
    readonly driver?: CodexReplay.CodexAppServerReplayDriver;
  }) {
    const connections = CodexReplay.splitReplayConnections(input.transcript);
    // Each thread runs its own app-server, so each recorded connection belongs to one
    // session: a session's first open takes the next connection, and a reopen continues
    // its own (a recorded restart shows up there as a runtime_exit). A single-connection
    // recording serves every session, as before. Only the caller's emit hook carries over.
    const drivers =
      connections.length <= 1
        ? undefined
        : yield* Effect.forEach(connections, (connection) =>
            CodexReplay.makeReplayDriver(
              connection,
              input.driver?.beforeEmitInbound === undefined
                ? {}
                : { beforeEmitInbound: input.driver.beforeEmitInbound },
            ),
          );
    const driverBySession = yield* Ref.make(
      new Map<string, CodexReplay.CodexAppServerReplayDriver>(),
    );
    return CodexAdapterV2.CodexAppServerClientFactory.of({
      open: (openInput) =>
        Effect.gen(function* () {
          const driver =
            drivers === undefined
              ? input.driver
              : yield* Ref.modify(driverBySession, (assigned) => {
                  const existing = assigned.get(openInput.providerSessionId);
                  const next = existing ?? drivers[assigned.size];
                  return next === undefined || existing !== undefined
                    ? [next, assigned]
                    : [next, new Map(assigned).set(openInput.providerSessionId, next)];
                });
          if (drivers !== undefined && driver === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              providerSessionId: openInput.providerSessionId,
              cause: `The replay recorded ${drivers.length} app-server connections, and every one already belongs to another session.`,
            });
          }
          const layerReplay =
            driver === undefined
              ? CodexReplay.layerReplay(input.transcript)
              : CodexReplay.layerReplayWithDriver(driver);
          const context = yield* Layer.build(layerReplay).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
          );
          return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.map((client) => withCodexReplayChildMetadata(client, input.transcript)),
            Effect.provide(context),
          );
        }),
    });
  },
);

export function layer(input: {
  readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
  readonly driver?: CodexReplay.CodexAppServerReplayDriver;
}) {
  const layerReplayClientFactory = Layer.effect(
    CodexAdapterV2.CodexAppServerClientFactory,
    makeReplayClientFactory(input),
  );
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(input.transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      // Keeps replay sessions away from the developer's real ~/.codex/auth.json.
      const codexHome = yield* (yield* FileSystem.FileSystem)
        .makeTempDirectoryScoped()
        .pipe(Effect.orDie);
      const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
        enabled: true,
        config: DEFAULT_CODEX_SETTINGS,
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerReplayClientFactory,
        layerServerConfig,
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  return layerRegistry;
}

const decodeCodexAppServerReplayTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);

export const CodexOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CodexReplay.CodexAppServerReplayTranscript,
  CodexOrchestratorReplayHarnessError
> = {
  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
  decodeTranscript: (transcript) =>
    decodeCodexAppServerReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new CodexReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (
    transcript,
    options: { readonly replayGate?: ProviderReplayGate } = {},
  ) => {
    return Layer.effectContext(
      Effect.gen(function* () {
        const replayGate = options.replayGate;
        if (replayGate !== undefined) {
          yield* Effect.addFinalizer(() => Effect.sync(() => replayGate.releaseAll()));
        }
        const driver = yield* CodexReplay.makeReplayDriver(
          transcript,
          replayGate === undefined
            ? {}
            : {
                beforeEmitInbound: (entry) =>
                  Effect.promise((signal) => replayGate.beforeEmit(entry.label, signal)),
              },
        );
        return yield* Layer.build(layer({ transcript, driver }));
      }),
    );
  },
};
