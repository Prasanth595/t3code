// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds exact schema-encoded dispatch bytes.
import * as NodeCrypto from "node:crypto";
import { OrchestrationV2Command } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

export const encodeMissionCommand = Schema.encodeEffect(OrchestrationV2Command);
export const encodeMissionRuntime = Schema.encodeEffect(ProviderAdapterV2RuntimePolicy);

/** Both preparation and locked dispatch use this exact command/runtime binding. */
export const missionCommandHashes = (
  command: typeof OrchestrationV2Command.Encoded,
  projectId: string,
  runtime: typeof ProviderAdapterV2RuntimePolicy.Encoded,
) => {
  if (command.type !== "message.dispatch" && command.type !== "delegated_task.request") return undefined;
  const hash = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return {
    promptHash: hash(command.type === "delegated_task.request" ? command.task : command.text),
    optionsHash: hash(stableStringify({ command, projectId, runtime })),
  };
};
