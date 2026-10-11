import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeTurnStatus, TurnTokenUsage } from "@t3tools/contracts";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function normalizeClaudeTurnTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: ProviderRuntimeTurnStatus,
): TurnTokenUsage {
  const usage = result?.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const commonUsage = {
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}

/**
 * Usage a turn settles across its SDK results. A steered turn spans several:
 * the SDK ends the pre-steer segment with an `aborted_*` result the turn
 * survives, and each result's `usage` covers only its own segment, so billing
 * the final result alone drops every call before the steer. The adapter folds
 * every result here and bills the fold at finalize (issue #18245). Codex keeps
 * the analogous state in CodexTurnTokenUsage.ts.
 */
export interface ClaudeTurnTokenUsageAccumulator {
  /** Results folded into this accumulator. */
  results: number;
  inputTokens: number;
  /** False once a segment reports `input_tokens` that is not a usable total. */
  inputTokensKnown: boolean;
  cachedInputTokens: number;
  cachedInputSeen: boolean;
  /** False once a segment reports a present-but-unusable cache read count. */
  cachedInputMeasured: boolean;
  cacheCreationTokens: number;
  cacheCreationSeen: boolean;
  cacheCreationMeasured: boolean;
  outputTokens: number;
  outputTokensKnown: boolean;
  thinkingTokens: number;
  thinkingSeen: boolean;
}

export function makeClaudeTurnTokenUsageAccumulator(): ClaudeTurnTokenUsageAccumulator {
  return {
    results: 0,
    inputTokens: 0,
    inputTokensKnown: true,
    cachedInputTokens: 0,
    cachedInputSeen: false,
    cachedInputMeasured: true,
    cacheCreationTokens: 0,
    cacheCreationSeen: false,
    cacheCreationMeasured: true,
    outputTokens: 0,
    outputTokensKnown: true,
    thinkingTokens: 0,
    thinkingSeen: false,
  };
}

export function accumulateClaudeTurnTokenUsage(
  accumulator: ClaudeTurnTokenUsageAccumulator,
  result: { readonly subtype?: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
): void {
  const usage = result?.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return;
  }
  accumulator.results += 1;

  const uncachedInput = finiteNonNegativeInteger(usage.input_tokens);
  if (uncachedInput === undefined) {
    accumulator.inputTokensKnown = false;
  } else {
    accumulator.inputTokens += uncachedInput;
  }
  const cachedInput = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  if (cachedInput === undefined) {
    if (usage.cache_read_input_tokens != null) {
      accumulator.cachedInputMeasured = false;
    }
  } else {
    accumulator.cachedInputSeen = true;
    accumulator.cachedInputTokens += cachedInput;
  }
  const cacheCreation = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  if (cacheCreation === undefined) {
    if (usage.cache_creation_input_tokens != null) {
      accumulator.cacheCreationMeasured = false;
    }
  } else {
    accumulator.cacheCreationSeen = true;
    accumulator.cacheCreationTokens += cacheCreation;
  }
  const output = finiteNonNegativeInteger(usage.output_tokens);
  if (output === undefined) {
    accumulator.outputTokensKnown = false;
  } else {
    accumulator.outputTokens += output;
  }
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinking = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  if (thinking !== undefined) {
    accumulator.thinkingSeen = true;
    accumulator.thinkingTokens += thinking;
  }
}

/**
 * The usage record the folded segments sum to, read through
 * `normalizeClaudeTurnTokenUsage`'s eyes: an unusable present-but-invalid
 * count poisons the summed input exactly like a single misreported result
 * would, and a count no segment reported stays absent.
 */
function usageFromAccumulator(
  accumulator: ClaudeTurnTokenUsageAccumulator,
): Record<string, unknown> {
  const usage: Record<string, unknown> = {};
  if (accumulator.inputTokensKnown) {
    usage.input_tokens = accumulator.inputTokens;
  }
  if (!accumulator.cachedInputMeasured) {
    usage.cache_read_input_tokens = Number.NaN;
  } else if (accumulator.cachedInputSeen) {
    usage.cache_read_input_tokens = accumulator.cachedInputTokens;
  }
  if (!accumulator.cacheCreationMeasured) {
    usage.cache_creation_input_tokens = Number.NaN;
  } else if (accumulator.cacheCreationSeen) {
    usage.cache_creation_input_tokens = accumulator.cacheCreationTokens;
  }
  if (accumulator.outputTokensKnown) {
    usage.output_tokens = accumulator.outputTokens;
  }
  if (accumulator.thinkingSeen) {
    usage.output_tokens_details = { thinking_tokens: accumulator.thinkingTokens };
  }
  return usage;
}

/**
 * The turn's billable usage from every result folded so far. The finalizing
 * result must already be folded (the adapter folds each result as it settles);
 * `result` only carries the segment subtype that gates complete vs partial.
 * A turn that settled a single segment keeps billing that final result exactly
 * as before — the fold only changes turns that spanned several results, which
 * is where usage was being lost.
 */
export function completeClaudeTurnTokenUsage(
  accumulator: ClaudeTurnTokenUsageAccumulator,
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: ProviderRuntimeTurnStatus,
): TurnTokenUsage {
  const billFold = accumulator.results >= 2 || (accumulator.results === 1 && result === undefined);
  if (!billFold) {
    return normalizeClaudeTurnTokenUsage(result, hasSubagents, terminalStatus);
  }
  return normalizeClaudeTurnTokenUsage(
    {
      // A turn that never settled a final result cannot bill "complete" even
      // when it finished: only the folded segments' usage is accounted for.
      subtype: result?.subtype ?? "error_during_execution",
      usage: usageFromAccumulator(accumulator),
    },
    hasSubagents,
    terminalStatus,
  );
}
