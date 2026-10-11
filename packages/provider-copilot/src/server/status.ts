/**
 * GitHub Copilot status probe, version checking, and model discovery.
 *
 * @module provider-copilot/server/status
 */
import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type { CopilotSettings } from "../settings.ts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  COPILOT_DEFAULT_MODEL_SLUG,
  COPILOT_SUPPORTED_RUNTIME_MODES,
  makeCopilotAcpRuntime,
  resolveCopilotAcpBaseModelId,
} from "./acpSupport.ts";
import { sessionModelStateFromInitialize } from "@t3tools/provider-acp/server/runtimeModel";
import { normalizeEnterpriseHost, isEnterpriseHost } from "./enterpriseHost.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const COPILOT_ACP_INITIALIZE_TIMEOUT_MS = 8_000;

const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: COPILOT_DEFAULT_MODEL_SLUG,
    name: "Copilot Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-3.7-sonnet",
    name: "Claude 3.7 Sonnet",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-4o",
    name: "GPT-4o",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "o1",
    name: "o1",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "o3-mini",
    name: "o3-mini",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = copilotModelsFromSettings(copilotSettings.customModels);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
      },
    });
  });
}

function copilotModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = COPILOT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Models advertised by the ACP agent via initialize response. */
function buildCopilotModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveCopilotAcpBaseModelId(model.modelId);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(model.modelId.trim() === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

const runCopilotCliCommand = (
  copilotSettings: CopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = copilotSettings.binaryPath || "copilot";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const decodeAvailableCommands = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeAvailableCommand = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    input: Schema.optional(Schema.NullOr(Schema.Struct({ hint: Schema.String }))),
  }),
);

function copilotSlashCommandsFromInitialize(
  initialized: EffectAcpSchema.InitializeResponse,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands = decodeAvailableCommands(initialized._meta?.availableCommands);
  const byName = new Map<string, ServerProviderSlashCommand>([
    [COMPACT_SLASH_COMMAND.name, COMPACT_SLASH_COMMAND],
  ]);
  for (const entry of Option.getOrElse(commands, () => [])) {
    const decoded = decodeAvailableCommand(entry);
    if (Option.isNone(decoded)) continue;
    const command = decoded.value;
    const name = command.name.trim();
    if (!name) continue;
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    byName.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return [...byName.values()];
}

/** Reads model and command metadata from initialize._meta. */
const discoverCopilotMetadataViaAcpInitialize = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings,
      environment,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-copilot-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return {
      models: buildCopilotModelsFromSessionModelState(sessionModelStateFromInitialize(initialized)),
      slashCommands: copilotSlashCommandsFromInitialize(initialized),
    };
  }).pipe(Effect.scoped);

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  _cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = copilotModelsFromSettings(copilotSettings.customModels);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const host = normalizeEnterpriseHost(copilotSettings.enterpriseUrl);
  const isEnterprise = isEnterpriseHost(host);

  const versionResult = yield* runCopilotCliCommand(
    copilotSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute Copilot CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Copilot CLI is installed but timed out while running `copilot --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Copilot CLI exited with code ${versionOutput.code}.`,
      },
    });
  }

  const metadataResult = yield* discoverCopilotMetadataViaAcpInitialize(
    copilotSettings,
    environment,
  ).pipe(Effect.timeoutOption(COPILOT_ACP_INITIALIZE_TIMEOUT_MS), Effect.result);

  const metadata = Result.isSuccess(metadataResult)
    ? Option.getOrUndefined(metadataResult.success)
    : undefined;

  const models =
    metadata && metadata.models.length > 0
      ? copilotModelsFromSettings(copilotSettings.customModels, metadata.models)
      : fallbackModels;

  const hasExplicitToken = Boolean(copilotSettings.enterpriseToken?.trim());
  const authStatus = hasExplicitToken ? ("authenticated" as const) : ("unknown" as const);

  const enterpriseNote = isEnterprise ? ` Targeting ${host}.` : "";

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    ...(metadata?.slashCommands ? { slashCommands: metadata.slashCommands } : {}),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: authStatus },
      message: `GitHub Copilot CLI ${version ?? "available"}.${enterpriseNote}`,
    },
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)));
};
