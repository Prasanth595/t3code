import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpServer } from "effect/ai";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readNofunPersonaScope } from "../nofun/persona.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as MissionCompletionMcpService from "./MissionCompletionMcpService.ts";
import * as MissionCompletionToolkit from "./MissionCompletionToolkit.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpPolicy from "./MissionMcpPolicy.ts";
import * as MissionMcpService from "./MissionMcpService.ts";
import * as MissionMcpToolkit from "./MissionMcpToolkit.ts";
import * as MissionHandlers from "./toolkits/mission/handlers.ts";
import { MissionToolkit } from "./toolkits/mission/tools.ts";

/**
 * Production composition of `mission_get`, `mission_execute`, and
 * `mission_completion_route_read`. It wires the existing accepted pieces (the
 * MissionMcpAuthority resolver, MissionMcpService, MissionCompletionMcpService,
 * and the MissionMcpPolicyPublisher) and adds one thing: where the trusted
 * NoFun policy comes from.
 *
 * The policy is read once at server start from an owner-controlled local file
 * and published through MissionMcpPolicyPublisher, which decodes it strictly
 * and mints the revision. The file must state the NoFun team, environment,
 * allowed project ids, and bootstrap controller thread ids explicitly: nothing
 * is inferred from a persona, directory, repository, provider, or model. The
 * environment id in the file must equal this server's own environment id.
 * Editing or removing the file takes effect on the next server start; there is
 * no tool that edits policy.
 *
 * The tools register whether or not a policy is configured. Without a usable
 * policy the real resolver denies every call with `authority_unavailable`, and
 * this module replaces that error's message with the supported configuration
 * so the agent can tell its owner what to set. No default authority exists.
 */

/** Absolute path to the policy file; the default is under the T3 state directory. */
const POLICY_FILE_ENV = "T3CODE_NOFUN_MISSION_POLICY_FILE";
const DEFAULT_POLICY_FILE_SEGMENTS = ["nofun", "mission-mcp-policy.json"] as const;
const MAX_POLICY_FILE_BYTES = 64 * 1024;

class PolicyFileRejected extends Schema.TaggedError<PolicyFileRejected>()("PolicyFileRejected", {
  reason: Schema.Literals([
    "path_not_absolute",
    "unreadable",
    "untrusted_file",
    "too_large",
    "invalid",
    "environment_mismatch",
  ]),
}) {}

type PolicyState =
  | { readonly status: "active" }
  | { readonly status: "unconfigured" }
  | { readonly status: "rejected"; readonly reason: PolicyFileRejected["reason"] };

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const isCatchesPersona = (env: NodeJS.ProcessEnv = process.env) =>
  readNofunPersonaScope(env)?.info.id === "catches";

/**
 * Owner-only files: a regular file owned by the server's user that no other
 * user can write. POSIX permission bits carry no meaning on Windows.
 */
const isOwnerControlled = (info: FileSystem.File.Info, platform: NodeJS.Platform): boolean => {
  if (info.type !== "File") return false;
  if (platform === "win32") return true;
  const uid = process.getuid?.();
  return (
    (info.mode & 0o022) === 0 &&
    (uid === undefined || Option.isNone(info.uid) || info.uid.value === uid)
  );
};

/** None when the default file is absent (unconfigured); a named file that is absent is rejected. */
const readPolicyFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const named = yield* Config.String(POLICY_FILE_ENV).pipe(
    Config.option,
    Effect.map(Option.map((value) => value.trim())),
    Effect.map(Option.filter((value) => value.length > 0)),
    Effect.mapError(() => new PolicyFileRejected({ reason: "unreadable" })),
  );
  const policyPath = Option.getOrElse(named, () =>
    path.join(config.stateDir, ...DEFAULT_POLICY_FILE_SEGMENTS),
  );
  if (Option.isSome(named) && !path.isAbsolute(policyPath)) {
    return yield* new PolicyFileRejected({ reason: "path_not_absolute" });
  }
  const info = yield* fileSystem.stat(policyPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" && Option.isNone(named)
          ? Effect.succeedNone
          : Effect.fail(new PolicyFileRejected({ reason: "unreadable" })),
    }),
  );
  if (Option.isNone(info)) return Option.none<string>();
  if (!isOwnerControlled(info.value, platform)) {
    return yield* new PolicyFileRejected({ reason: "untrusted_file" });
  }
  if (Number(info.value.size) > MAX_POLICY_FILE_BYTES) {
    return yield* new PolicyFileRejected({ reason: "too_large" });
  }
  return yield* fileSystem.readFileString(policyPath).pipe(
    Effect.asSome,
    Effect.mapError(() => new PolicyFileRejected({ reason: "unreadable" })),
  );
});

/**
 * Publishes the file's policy when it is valid for this server, and leaves the
 * publisher disabled otherwise. Never fails: a bad policy must not stop the
 * server, only keep mission authority unavailable.
 */
const loadPolicy = Effect.fn("MissionMcpRuntime.loadPolicy")(
  function* (publisher: MissionMcpPolicy.MissionMcpPolicyPublisher) {
    // CATCHES is a separate company: its servers never read or publish NoFun mission authority.
    if (isCatchesPersona(yield* HostProcessEnvironment)) {
      return { status: "unconfigured" } as const satisfies PolicyState;
    }
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const contents = yield* readPolicyFile;
    if (Option.isNone(contents)) {
      yield* Effect.logDebug("NoFun mission MCP policy not configured", {
        policyFileEnv: POLICY_FILE_ENV,
      });
      return { status: "unconfigured" } as const satisfies PolicyState;
    }
    const published = yield* Effect.try({
      try: () => publisher.publish(decodeJson(contents.value)),
      catch: () => new PolicyFileRejected({ reason: "invalid" }),
    });
    if (published.environmentId !== (yield* environment.getEnvironmentId)) {
      publisher.revoke();
      return yield* new PolicyFileRejected({ reason: "environment_mismatch" });
    }
    yield* Effect.logInfo("NoFun mission MCP policy published", {
      allowedProjectCount: published.allowedProjectIds.length,
      bootstrapControllerCount: published.bootstrapControllerThreadIds.length,
    });
    return { status: "active" } as const satisfies PolicyState;
  },
  Effect.catchTags({
    PolicyFileRejected: (error) =>
      Effect.logWarning("NoFun mission MCP policy rejected; mission tools stay unavailable", {
        reason: error.reason,
        policyFileEnv: POLICY_FILE_ENV,
      }).pipe(
        Effect.as({ status: "rejected", reason: error.reason } as const satisfies PolicyState),
      ),
  }),
);

const configurationGuidance = (state: Exclude<PolicyState, { status: "active" }>): string =>
  state.status === "unconfigured"
    ? `Mission authority is not configured on this T3 server. The owner must create the NoFun mission policy file (nofun/${DEFAULT_POLICY_FILE_SEGMENTS[1]} under the T3 state directory, or the absolute path in ${POLICY_FILE_ENV}) naming the NoFun team, this environment, the allowed project ids, and the bootstrap controller thread ids, then restart the server.`
    : `The NoFun mission policy file was rejected (${state.reason}). The owner must fix it (or ${POLICY_FILE_ENV}) and restart the server.`;

/** Only unavailable-authority failures carry the guidance; every other code passes through. */
const withGuidance =
  (state: PolicyState) =>
  (error: MissionMcpService.MissionMcpFailure): MissionMcpService.MissionMcpFailure =>
    state.status === "active" || error.code !== "authority_unavailable"
      ? error
      : new MissionMcpService.MissionMcpFailure({
          code: "authority_unavailable",
          message: configurationGuidance(state),
        });

/** Builds `layer` under the caller's scope and memo map and returns its one service. */
const buildService = <I, S, E, R>(tag: Context.Service<I, S>, layer: Layer.Layer<I, E, R>) =>
  Layer.build(layer).pipe(Effect.map((context) => Context.get(context, tag)));

const layerMissionService = <E, R>(
  state: PolicyState,
  authorityPort: Layer.Layer<MissionMcpService.MissionMcpAuthorityPort, E, R>,
) =>
  Layer.effect(
    MissionMcpService.MissionMcpService,
    Effect.gen(function* () {
      const port = yield* MissionMcpService.MissionMcpAuthorityPort;
      const inner = yield* buildService(
        MissionMcpService.MissionMcpService,
        MissionMcpService.layer.pipe(
          Layer.provide(EventStore.layer),
          Layer.provide(Receipts.layer),
        ),
      );
      // The service looks the resolver up in the calling fiber, not at build, so
      // hand it over per call instead of relying on the toolkit's captured context.
      const bind = <A>(effect: Effect.Effect<A, MissionMcpService.MissionMcpFailure>) =>
        effect.pipe(
          Effect.provideService(MissionMcpService.MissionMcpAuthorityPort, port),
          Effect.mapError(withGuidance(state)),
        );
      return MissionMcpService.MissionMcpService.of({
        get: (scope, input) => bind(inner.get(scope, input)),
        execute: (scope, input) => bind(inner.execute(scope, input)),
      });
    }),
  ).pipe(Layer.provide(authorityPort));

const layerCompletionService = <E, R>(
  state: PolicyState,
  authorityPort: Layer.Layer<MissionMcpService.MissionMcpAuthorityPort, E, R>,
) =>
  Layer.effect(
    MissionCompletionMcpService.MissionCompletionMcpService,
    Effect.gen(function* () {
      const inner = yield* buildService(
        MissionCompletionMcpService.MissionCompletionMcpService,
        MissionCompletionMcpService.layer.pipe(Layer.provide(authorityPort)),
      );
      return MissionCompletionMcpService.MissionCompletionMcpService.of({
        resolve: (scope, selector) =>
          inner.resolve(scope, selector).pipe(Effect.mapError(withGuidance(state))),
      });
    }),
  );

/**
 * Provides the trusted mission policy, the MissionMcpService, and the
 * MissionCompletionMcpService that `layerOptionalToolkits` registers. The
 * server composes this once, over its real session registry, environment,
 * projections, and SQL.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const publisher = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    const state = yield* loadPolicy(publisher);
    const policy = Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, publisher.policy);
    const authorityPort = MissionMcpAuthority.layer.pipe(Layer.provide(policy));
    return Layer.mergeAll(
      policy,
      layerMissionService(state, authorityPort),
      layerCompletionService(state, authorityPort),
    );
  }),
);

const layerMissionToolkit = (service: MissionMcpService.MissionMcpService["Service"]) =>
  McpServer.toolkit(MissionToolkit).pipe(
    Layer.provide(MissionHandlers.layer),
    Layer.provide(Layer.succeed(MissionMcpService.MissionMcpService, service)),
  );

const layerMissionToolkitOptional = Layer.unwrap(
  Effect.all([
    Effect.serviceOption(MissionMcpService.MissionMcpService),
    Effect.serviceOption(MissionMcpAuthority.MissionMcpTrustedPolicy),
  ]).pipe(
    Effect.map(([service, policy]) =>
      Option.isNone(service) || Option.isNone(policy)
        ? MissionMcpToolkit.layerOptionalMissionToolkit
        : layerMissionToolkit(service.value),
    ),
  ),
);

/**
 * Registers the mission tools over the services `layer` provides. Outside a
 * server that composes `layer` they stay out of the catalog, or, when only a
 * trusted policy is present, fall back to the policy-only registration. CATCHES
 * servers never register them.
 */
export const layerOptionalToolkits = isCatchesPersona()
  ? Layer.empty
  : Layer.mergeAll(
      layerMissionToolkitOptional,
      MissionCompletionToolkit.layerOptionalMissionCompletionToolkit,
    );
