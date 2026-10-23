import { ProviderTurnId, RunAttemptId, RunId } from "@t3tools/contracts";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveActiveTurnLastActivityAt, formatIdleHint } from "./TimelineWorkGroupRows.logic";

const runId = RunId.make("run-1");
const oldAttemptId = RunAttemptId.make("attempt-1");
const attemptId = RunAttemptId.make("attempt-2");
const oldTurnId = ProviderTurnId.make("turn-1");
const turnId = ProviderTurnId.make("turn-2");
const at = (time: string) => DateTime.makeUnsafe(`2026-10-22T${time}.000Z`);

const projection = (attemptStartedAt: string) => ({
  runs: [{ id: runId, activeAttemptId: attemptId }],
  attempts: [
    { id: oldAttemptId, startedAt: at("12:00:00") },
    { id: attemptId, startedAt: at(attemptStartedAt) },
  ],
  providerTurns: [
    { id: oldTurnId, runAttemptId: oldAttemptId },
    { id: turnId, runAttemptId: attemptId },
  ],
});

const item = (input: {
  readonly status: string;
  readonly updatedAt: string;
  readonly providerTurnId?: ProviderTurnId;
  readonly runId?: RunId;
}) =>
  ({
    item: {
      runId: input.runId ?? runId,
      providerTurnId: input.providerTurnId ?? turnId,
      status: input.status,
      startedAt: at("12:00:00"),
      completedAt: input.status === "completed" ? at(input.updatedAt) : null,
      updatedAt: at(input.updatedAt),
    },
  }) as unknown as ThreadStructureVisibleTurnItem;

const derive = (
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  attemptStartedAt = "12:00:00",
) =>
  deriveActiveTurnLastActivityAt({
    projection: projection(attemptStartedAt) as never,
    runId,
    workStartedAt: "2026-10-22T12:00:00.000Z",
    items,
  });

describe("deriveActiveTurnLastActivityAt", () => {
  it("uses the latest item activity of the active run", () => {
    expect(
      derive([
        item({ status: "completed", updatedAt: "12:04:00" }),
        item({ status: "completed", updatedAt: "12:09:00", runId: RunId.make("run-other") }),
        item({ status: "running", updatedAt: "12:09:00", runId: RunId.make("run-other") }),
      ]),
    ).toBe("2026-10-22T12:04:00.000Z");
  });

  it("is null while an item of the current attempt is in progress", () => {
    expect(derive([item({ status: "running", updatedAt: "12:01:00" })])).toBeNull();
  });

  it("starts over from a restart and ignores the superseded attempt's open items", () => {
    expect(
      derive(
        [
          item({ status: "completed", updatedAt: "12:03:00" }),
          item({ status: "running", updatedAt: "12:04:00", providerTurnId: oldTurnId }),
        ],
        "12:05:00",
      ),
    ).toBe("2026-10-22T12:05:00.000Z");
  });
});

describe("deriveActiveTurnLastActivityAt without a baseline", () => {
  it("is null with no attempt, work start, or item activity", () => {
    expect(
      deriveActiveTurnLastActivityAt({
        projection: { runs: [], attempts: [], providerTurns: [] } as never,
        runId,
        workStartedAt: null,
        items: [],
      }),
    ).toBeNull();
  });
});

describe("formatIdleHint", () => {
  const lastActivityAt = "2026-10-22T12:00:00.000Z";
  const after = (ms: number) => Date.parse(lastActivityAt) + ms;

  it("stays quiet below three minutes", () => {
    expect(formatIdleHint(lastActivityAt, after(2 * 60_000 + 59_000))).toBeNull();
    expect(formatIdleHint(null, after(60 * 60_000))).toBeNull();
  });

  it("reports whole minutes from the threshold on", () => {
    expect(formatIdleHint(lastActivityAt, after(3 * 60_000))).toBe("No activity for 3m");
    expect(formatIdleHint(lastActivityAt, after(15 * 60_000 + 35_000))).toBe("No activity for 15m");
    expect(formatIdleHint(lastActivityAt, after(75 * 60_000))).toBe("No activity for 1h 15m");
  });
});
