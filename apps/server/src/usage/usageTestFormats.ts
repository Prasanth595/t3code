import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { piUsageFormat } from "@t3tools/provider-pi/server/usage";

export const TEST_FORMATS: Record<"pi", TranscriptUsageFormat<unknown>> = {
  pi: piUsageFormat,
};

export const TEST_FORMAT_MAP = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>(
  Object.entries(TEST_FORMATS) as Array<[UsageProviderKind, TranscriptUsageFormat<unknown>]>,
);
