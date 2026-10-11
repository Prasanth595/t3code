/**
 * Spawn and communication primitives for GitHub Copilot's ACP server.
 *
 * @module provider-copilot/server/acpSupport
 */
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";
import {
  type ProviderApprovalOption,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { CopilotSettings } from "../settings.ts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

type CopilotAcpRuntimeSettings = Pick<CopilotSettings, "binaryPath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn"
> {
  readonly copilotSettings: CopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const COPILOT_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

function copilotAcpSpawnArgs(): ReadonlyArray<string> {
  return ["--acp"];
}

function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: [...copilotAcpSpawnArgs()],
    cwd,
    ...(environment !== undefined ? { env: environment } : {}),
  };
}

export const COPILOT_DEFAULT_MODEL_SLUG = "default";

export function resolveCopilotAcpBaseModelId(raw: string | undefined): string {
  const normalized = normalizeModelSlug(raw ?? COPILOT_DEFAULT_MODEL_SLUG, COPILOT_DRIVER_KIND);
  return normalized || COPILOT_DEFAULT_MODEL_SLUG;
}

export function copilotApprovalOptions(
  _request?: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "cancel", label: "Cancel" },
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
  ];
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(
          input.copilotSettings,
          input.cwd ?? process.cwd(),
          input.environment,
        ),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
