import { acpRegistryPromptFailure } from "@t3tools/provider-acp-registry/server";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { readGlmUsageLimits } from "./usageLimits.ts";

function failureWindow(message: string) {
  const period = /^429\s+Usage limit reached for\s+([^.]+)\./iu.exec(message)?.[1]?.trim();
  if (period === undefined) return undefined;
  if (/^5\s+hours?$/iu.test(period)) return "session";
  if (/^(?:7\s+days?|(?:1\s+)?weeks?|weekly)$/iu.test(period)) return "weekly";
  if (/^(?:(?:1\s+)?months?|monthly)$/iu.test(period)) return "monthly";
  return undefined;
}

export const readGlmPromptFailure = Effect.fn("GlmPromptFailure.read")(function* (input: {
  readonly cause: unknown;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const failure = acpRegistryPromptFailure("glm-acp-agent", input.cause);
  if (failure.class !== "usage_limit") return failure;
  const kind = failureWindow(failure.message);
  if (kind === undefined) return failure;
  const limits = yield* readGlmUsageLimits({ enabled: true, environment: input.environment }).pipe(
    Effect.catchDefect(() => Effect.void),
  );
  if (!limits || limits.unavailable) return failure;
  const required = limits.windows.find((window) => window.kind === kind);
  if (!required) return failure;
  const blocking = limits.windows.filter(
    (window) =>
      window === required ||
      ((window.kind === "session" || window.kind === "weekly") && window.usedPercent >= 100),
  );
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  let resetAt: string | undefined;
  let latestReset = now;
  // GLM's error timestamp has no timezone; only the quota API supplies an absolute reset.
  for (const window of blocking) {
    const reset = window.resetsAt ? DateTime.make(window.resetsAt) : Option.none();
    if (Option.isNone(reset)) return failure;
    const millis = DateTime.toEpochMillis(reset.value);
    if (millis <= now) return failure;
    if (millis > latestReset) {
      latestReset = millis;
      resetAt = DateTime.formatIso(reset.value);
    }
  }
  return resetAt === undefined ? failure : { ...failure, resetAt };
});
