import {
  CommandId,
  ProviderInstanceId,
  ProjectId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type * as ProjectionStore from "./ProjectionStore.ts";
import { limitFallbackCommands, limitFallbackSelection } from "./UsageLimitRecoveryWorker.ts";

const codex = ProviderInstanceId.make("codex_backup");
const claude = ProviderInstanceId.make("claude_backup");
const gemini = ProviderInstanceId.make("gemini_backup");
const selection = (instanceId: ProviderInstanceId, model: string): ModelSelection => ({
  instanceId,
  model,
});

const failedRun = selection(codex, "gpt-5");
const claudeFallback = selection(claude, "opus-4");
const everythingEnabled = () => true;

describe("limitFallbackSelection", () => {
  it("continues on the entry after the model that hit the limit", () => {
    assert.deepEqual(
      limitFallbackSelection(failedRun, [failedRun, claudeFallback], everythingEnabled),
      claudeFallback,
    );
  });

  it("starts at the chain head when the chain does not name the failed model", () => {
    assert.deepEqual(
      limitFallbackSelection(failedRun, [claudeFallback], everythingEnabled),
      claudeFallback,
    );
  });

  it("skips an instance that is turned off", () => {
    assert.deepEqual(
      limitFallbackSelection(
        failedRun,
        [claudeFallback, selection(gemini, "gemini-3")],
        (id) => id !== claude,
      ),
      selection(gemini, "gemini-3"),
    );
  });

  it("treats the same model with different options as the one that hit the limit", () => {
    const failed = {
      ...failedRun,
      options: [{ id: "reasoningEffort", value: "high" }],
    } satisfies ModelSelection;
    assert.deepEqual(
      limitFallbackSelection(failed, [failedRun, claudeFallback], everythingEnabled),
      claudeFallback,
    );
  });

  it("runs out rather than retrying the model that hit the limit", () => {
    assert.isNull(limitFallbackSelection(failedRun, [failedRun], everythingEnabled));
    assert.isNull(limitFallbackSelection(failedRun, [], everythingEnabled));
  });

  it("advances past a fallback that is itself limited", () => {
    const chain = [failedRun, claudeFallback, selection(gemini, "gemini-3")];
    assert.deepEqual(
      limitFallbackSelection(claudeFallback, chain, everythingEnabled),
      selection(gemini, "gemini-3"),
    );
    assert.isNull(limitFallbackSelection(selection(gemini, "gemini-3"), chain, everythingEnabled));
  });
});

const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

const candidate = (
  overrides: Partial<ProjectionStore.ProjectionLimitRecoveryCandidate> = {},
): ProjectionStore.ProjectionLimitRecoveryCandidate => ({
  id: ThreadId.make("fallback-thread"),
  projectId: ProjectId.make("fallback-project"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("fallback-run"),
  usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe("2026-01-01T01:00:00.000Z")),
  latestRunCompletedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  limitRecovery: null,
  snoozedUntil: null,
  runModelSelection: failedRun,
  ...overrides,
});

describe("limitFallbackCommands", () => {
  it("moves the selection first, then continues on that same selection", () => {
    const commands = limitFallbackCommands(candidate(), claudeFallback, now);
    assert.isNotNull(commands);
    const [switchCommand, continuation] = commands;
    assert.equal(switchCommand?.type, "thread.model-selection.set");
    assert.equal(
      switchCommand?.commandId,
      CommandId.make("limit-fallback-switch:fallback-thread:fallback-run:claude_backup:opus-4"),
    );
    assert.equal(
      switchCommand?.type === "thread.model-selection.set" ? switchCommand.threadId : null,
      ThreadId.make("fallback-thread"),
    );
    assert.deepEqual(
      switchCommand?.type === "thread.model-selection.set" ? switchCommand.modelSelection : null,
      claudeFallback,
    );
    assert.equal(continuation?.type, "message.dispatch");
    assert.equal(
      continuation?.type === "message.dispatch" ? continuation.usageLimitContinuationOfRunId : null,
      RunId.make("fallback-run"),
    );
    assert.deepEqual(
      continuation?.type === "message.dispatch" ? continuation.modelSelection : null,
      claudeFallback,
    );
  });

  it("continues without a reset time, unlike resume-at-reset", () => {
    assert.isNotNull(
      limitFallbackCommands(candidate({ usageLimitResetAt: null }), claudeFallback, now),
    );
  });

  it("stays quiet while the thread is snoozed", () => {
    assert.isNull(
      limitFallbackCommands(
        candidate({ snoozedUntil: DateTime.makeUnsafe("2026-01-01T01:00:00.000Z") }),
        claudeFallback,
        now,
      ),
    );
  });

  it("refuses a thread that is archived or settled", () => {
    assert.isNull(
      limitFallbackCommands(
        candidate({ archivedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z") }),
        claudeFallback,
        now,
      ),
    );
    assert.isNull(
      limitFallbackCommands(candidate({ settledOverride: "settled" }), claudeFallback, now),
    );
  });
});
