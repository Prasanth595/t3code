import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type { AcpPromptBusyRetryPolicy } from "@t3tools/provider-acp/server/promptBusyRetry";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * minimax-code keeps a turn lease on the session until the interrupted turn has
 * finished unwinding, and rejects any prompt that arrives while the lease is
 * still held:
 *
 *   "Session already has an active Turn. Use queue send to deliver the message
 *   after it."
 *
 * The agent never sees the rejected prompt, so the same prompt is accepted once
 * the lease is released.
 */
const MINIMAX_CODE_BUSY_PATTERN = /already has an active turn/i;

function isMinimaxCodeBusyError(error: unknown): boolean {
  return isAcpRequestError(error) && MINIMAX_CODE_BUSY_PATTERN.test(error.errorMessage);
}

export const isMinimaxCodeBusyFailure: AcpPromptBusyRetryPolicy["isBusyFailure"] = (cause) => {
  const error = Cause.findError(cause);
  return Result.isSuccess(error) && isMinimaxCodeBusyError(error.success);
};

/**
 * The lease is released within seconds of the interrupt, so a short backoff
 * recovers the turn long before the user notices a failed prompt.
 */
export const minimaxCodePromptBusyRetry: AcpPromptBusyRetryPolicy = {
  maxAttempts: 5,
  isBusyFailure: isMinimaxCodeBusyFailure,
  delayMs: (attempt) => Math.min(10_000, 1_000 * 2 ** (attempt - 1)),
};

/**
 * minimax-code holds a turn lease on the session until the interrupted turn
 * has finished unwinding, so a prompt that arrives in that window is re-sent
 * instead of failing the turn.
 */
export function acpRegistryAgentFlavorExtras(
  registryAgentId: string,
): Pick<AcpAdapterV2Flavor, "promptBusyRetry"> {
  return registryAgentId === "minimax-code" ? { promptBusyRetry: minimaxCodePromptBusyRetry } : {};
}
