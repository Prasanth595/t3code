import { assert, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Mission } from "../../../../packages/contracts/src/mission.ts";
import {
  evaluateManagerRotation,
  MAX_SAME_DAY_ORDINAL,
  type EvaluateManagerRotationInput,
  type RotationSafeBoundary,
} from "./MissionManagerRotation.ts";

const DENVER = "America/Denver";
const OCCURRED_AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (overrides: Record<string, unknown> = {}) =>
  decodeMission({
    schemaVersion: 1,
    id: "mission-1",
    revision: 4,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
        ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
      },
    ],
    intent: {
      outcome: "Ship the opt-in mission aggregate.",
      scope: ["contracts"],
      exclusions: ["persistence"],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: {
      delivery: { threadId: "thread-delivery", epoch: 3 },
      retro: { threadId: "thread-retro", epoch: 1 },
    },
    status: "active",
    tasks: [],
    updatedAt: OCCURRED_AT,
    ...overrides,
  });

const CLEAR: RotationSafeBoundary = {
  incumbentIntegrationRunning: false,
  incumbentGuiOwned: false,
  unresolvedShellWrite: false,
  sharedWriteUnknown: false,
  quiescenceUnknown: false,
  childWorkersPending: false,
  completionRoutingReady: true,
};

const baseInput = (overrides: Partial<EvaluateManagerRotationInput> = {}) =>
  ({
    mission: missionFixture(),
    role: "delivery",
    projectTimezone: DENVER,
    nowIso: "2026-10-14T12:00:00.000Z",
    lastSlot: { localDate: "2026-10-13", ordinal: 0 },
    safeBoundary: { ...CLEAR },
    userStopRequested: false,
    userPauseRequested: false,
    ...overrides,
  }) as EvaluateManagerRotationInput;

describe("MissionManagerRotation", () => {
  it("prepares the first needed slot when no prior slot exists", () => {
    const decision = evaluateManagerRotation(baseInput({ lastSlot: null }));
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") return;
    assert.strictEqual(decision.intent.reason, "first_slot");
    assert.strictEqual(decision.intent.ordinal, 0);
    assert.strictEqual(decision.intent.localDate, "2026-10-14");
  });

  it("rotates once on a new local day", () => {
    const decision = evaluateManagerRotation(baseInput({}));
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") return;
    assert.strictEqual(decision.intent.reason, "new_local_day");
    assert.strictEqual(decision.intent.localDate, "2026-10-14");
    assert.strictEqual(decision.intent.ordinal, 0);
  });

  it("uses the local-midnight boundary, not UTC midnight", () => {
    const before = evaluateManagerRotation(
      baseInput({ nowIso: "2026-10-14T05:59:59.000Z" }),
    );
    assert.strictEqual(before.kind, "noop");
    const after = evaluateManagerRotation(
      baseInput({ nowIso: "2026-10-14T06:00:00.000Z" }),
    );
    assert.strictEqual(after.kind, "rotate");
    if (after.kind !== "rotate") return;
    assert.strictEqual(after.intent.localDate, "2026-10-14");
  });

  it("crosses the spring-forward 23-hour day by calendar date", () => {
    // 2026-03-08T08:30Z is 01:30 MST, before the 02:00 -> 03:00 jump.
    const before = evaluateManagerRotation(
      baseInput({
        nowIso: "2026-03-08T08:30:00.000Z",
        lastSlot: { localDate: "2026-03-08", ordinal: 0 },
      }),
    );
    assert.strictEqual(before.kind, "noop");
    // 2026-03-08T09:30Z is 03:30 MDT, after the jump, still the same date.
    const afterJump = evaluateManagerRotation(
      baseInput({
        nowIso: "2026-03-08T09:30:00.000Z",
        lastSlot: { localDate: "2026-03-08", ordinal: 0 },
      }),
    );
    assert.strictEqual(afterJump.kind, "noop");
    const nextDay = evaluateManagerRotation(
      baseInput({
        nowIso: "2026-03-09T06:30:00.000Z",
        lastSlot: { localDate: "2026-03-08", ordinal: 0 },
      }),
    );
    assert.strictEqual(nextDay.kind, "rotate");
    if (nextDay.kind !== "rotate") return;
    assert.strictEqual(nextDay.intent.localDate, "2026-03-09");
  });

  it("crosses the fall-back 25-hour day by calendar date", () => {
    // Both 07:30Z (01:30 MDT) and 08:30Z (01:30 MST) are 2026-11-01 locally.
    const repeatedHour = evaluateManagerRotation(
      baseInput({
        nowIso: "2026-11-01T08:30:00.000Z",
        lastSlot: { localDate: "2026-10-31", ordinal: 0 },
      }),
    );
    assert.strictEqual(repeatedHour.kind, "rotate");
    if (repeatedHour.kind !== "rotate") return;
    assert.strictEqual(repeatedHour.intent.localDate, "2026-11-01");
    assert.strictEqual(repeatedHour.intent.reason, "new_local_day");
  });

  it("plans only today's slot after skipped offline days, never a backlog", () => {
    const decision = evaluateManagerRotation(
      baseInput({ lastSlot: { localDate: "2026-10-10", ordinal: 2 } }),
    );
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") return;
    assert.strictEqual(decision.intent.localDate, "2026-10-14");
    assert.strictEqual(decision.intent.ordinal, 0);
    assert.strictEqual(decision.intent.reason, "new_local_day");
  });

  it.each([
    ["missing timezone", { projectTimezone: undefined }, "missing_timezone"],
    ["empty timezone", { projectTimezone: "" }, "missing_timezone"],
    ["unknown zone", { projectTimezone: "Mars/Olympus" }, "invalid_timezone"],
    ["fixed offset instead of IANA zone", { projectTimezone: "UTC+6" }, "invalid_timezone"],
  ])("holds on %s without defaulting to a system zone", (_label, patch, reason) => {
    const decision = evaluateManagerRotation(baseInput(patch));
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, reason);
  });

  it("holds on an invalid captured instant", () => {
    const decision = evaluateManagerRotation(baseInput({ nowIso: "not-an-instant" }));
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, "invalid_now");
  });

  it.each([
    ["non-calendar overflow day", "2026-02-30", "invalid_slot_day"],
    ["invalid month", "2026-13-01", "invalid_slot_day"],
    ["wrong shape", "10/14/2026", "invalid_slot_day"],
  ])("holds on %s", (_label, localDate, reason) => {
    const decision = evaluateManagerRotation(
      baseInput({ lastSlot: { localDate, ordinal: 0 } }),
    );
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, reason);
  });

  it("holds on a last slot dated in the future", () => {
    const decision = evaluateManagerRotation(
      baseInput({ lastSlot: { localDate: "2026-10-15", ordinal: 0 } }),
    );
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, "future_slot");
  });

  it.each([
    ["negative ordinal", -1],
    ["non-integer ordinal", 1.5],
    ["ordinal above the bound", MAX_SAME_DAY_ORDINAL + 1],
  ])("holds on %s", (_label, ordinal) => {
    const decision = evaluateManagerRotation(
      baseInput({ lastSlot: { localDate: "2026-10-13", ordinal } }),
    );
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, "invalid_slot_ordinal");
  });

  it("holds when the role has no bound manager thread and epoch", () => {
    const withoutRetro = missionFixture({ managers: { delivery: { threadId: "t", epoch: 0 } } });
    const missing = evaluateManagerRotation(
      baseInput({ mission: withoutRetro, role: "retro", retroQueueDepth: 2 }),
    );
    assert.strictEqual(missing.kind, "hold");
    if (missing.kind !== "hold") return;
    assert.strictEqual(missing.reason, "missing_manager");

    const epochless = missionFixture({ managers: { delivery: { threadId: "t" } } });
    const noEpoch = evaluateManagerRotation(baseInput({ mission: epochless }));
    assert.strictEqual(noEpoch.kind, "hold");
    if (noEpoch.kind !== "hold") return;
    assert.strictEqual(noEpoch.reason, "missing_manager");
  });

  it("binds the prepared intent to mission, revision, role, thread, and epoch", () => {
    const decision = evaluateManagerRotation(baseInput({}));
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") return;
    assert.deepStrictEqual(decision.intent, {
      missionId: "mission-1",
      observedRevision: 4,
      role: "delivery",
      currentThreadId: "thread-delivery",
      currentEpoch: 3,
      timezone: DENVER,
      localDate: "2026-10-14",
      ordinal: 0,
      reason: "new_local_day",
    });
    expect(decision.intent).not.toHaveProperty("successorThreadId");
  });

  it.each([
    ["paused", "paused"],
    ["completed", "completed"],
    ["stopped", "stopped"],
  ])("never rotates a %s mission", (_label, status) => {
    const decision = evaluateManagerRotation(
      baseInput({ mission: missionFixture({ status }), lastSlot: null }),
    );
    assert.strictEqual(decision.kind, "noop");
    if (decision.kind !== "noop") return;
    assert.strictEqual(decision.reason, "mission_inactive");
  });

  it("lets an explicit user stop or pause win over rotation", () => {
    const stopped = evaluateManagerRotation(baseInput({ lastSlot: null, userStopRequested: true }));
    assert.strictEqual(stopped.kind, "noop");
    if (stopped.kind !== "noop") return;
    assert.strictEqual(stopped.reason, "user_stop");

    const paused = evaluateManagerRotation(baseInput({ lastSlot: null, userPauseRequested: true }));
    assert.strictEqual(paused.kind, "noop");
    if (paused.kind !== "noop") return;
    assert.strictEqual(paused.reason, "user_pause");
  });

  it("never rotates the retro role on an empty queue, but rotates when queued", () => {
    const empty = evaluateManagerRotation(
      baseInput({ role: "retro", lastSlot: null, retroQueueDepth: 0 }),
    );
    assert.strictEqual(empty.kind, "noop");
    if (empty.kind !== "noop") return;
    assert.strictEqual(empty.reason, "empty_retro_queue");

    const queued = evaluateManagerRotation(
      baseInput({ role: "retro", lastSlot: null, retroQueueDepth: 2 }),
    );
    assert.strictEqual(queued.kind, "rotate");
    if (queued.kind !== "rotate") return;
    assert.strictEqual(queued.intent.role, "retro");
    assert.strictEqual(queued.intent.currentThreadId, "thread-retro");

    const unknown = evaluateManagerRotation(baseInput({ role: "retro", lastSlot: null }));
    assert.strictEqual(unknown.kind, "hold");
    if (unknown.kind !== "hold") return;
    assert.strictEqual(unknown.reason, "unknown_retro_queue");

    const deliveryIgnoresQueue = evaluateManagerRotation(
      baseInput({ role: "delivery", lastSlot: null, retroQueueDepth: 0 }),
    );
    assert.strictEqual(deliveryIgnoresQueue.kind, "rotate");
  });

  it.each([
    ["running incumbent integration", { incumbentIntegrationRunning: true }, "incumbent_integration"],
    ["incumbent GUI ownership", { incumbentGuiOwned: true }, "gui_ownership"],
    ["unresolved shell write", { unresolvedShellWrite: true }, "unresolved_shell_write"],
    ["unknown shared writes", { sharedWriteUnknown: true }, "unknown_shared_write"],
    ["unknown quiescence", { quiescenceUnknown: true }, "unknown_quiescence"],
    ["unconfirmed completion routing", { completionRoutingReady: false }, "completion_routing_unconfirmed"],
  ])("holds while %s", (_label, patch, reason) => {
    const decision = evaluateManagerRotation(
      baseInput({ lastSlot: null, safeBoundary: { ...CLEAR, ...patch } }),
    );
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, reason);
  });

  it("holds legacy completion routing even with pending child workers", () => {
    const decision = evaluateManagerRotation(
      baseInput({
        lastSlot: null,
        safeBoundary: { ...CLEAR, childWorkersPending: true, completionRoutingReady: false },
      }),
    );
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.strictEqual(decision.reason, "completion_routing_unconfirmed");
  });

  it("lets pending child workers alone proceed once routing is proven", () => {
    const decision = evaluateManagerRotation(
      baseInput({
        lastSlot: null,
        safeBoundary: { ...CLEAR, childWorkersPending: true, completionRoutingReady: true },
      }),
    );
    assert.strictEqual(decision.kind, "rotate");
  });

  it("stays noop on the same day, and increments ordinal under context pressure", () => {
    const sameDay = evaluateManagerRotation(
      baseInput({ lastSlot: { localDate: "2026-10-14", ordinal: 0 } }),
    );
    assert.strictEqual(sameDay.kind, "noop");
    if (sameDay.kind !== "noop") return;
    assert.strictEqual(sameDay.reason, "same_day");

    const pressured = evaluateManagerRotation(
      baseInput({
        lastSlot: { localDate: "2026-10-14", ordinal: 0 },
        contextPressure: { requested: true, reason: "context window at 80%" },
      }),
    );
    assert.strictEqual(pressured.kind, "rotate");
    if (pressured.kind !== "rotate") return;
    assert.strictEqual(pressured.intent.ordinal, 1);
    assert.strictEqual(pressured.intent.localDate, "2026-10-14");
    assert.strictEqual(pressured.intent.reason, "context_pressure");
  });

  it("holds context pressure without a reason and past the ordinal bound", () => {
    const reasonless = evaluateManagerRotation(
      baseInput({
        lastSlot: { localDate: "2026-10-14", ordinal: 0 },
        contextPressure: { requested: true },
      }),
    );
    assert.strictEqual(reasonless.kind, "hold");
    if (reasonless.kind !== "hold") return;
    assert.strictEqual(reasonless.reason, "missing_context_reason");

    const overflow = evaluateManagerRotation(
      baseInput({
        lastSlot: { localDate: "2026-10-14", ordinal: MAX_SAME_DAY_ORDINAL },
        contextPressure: { requested: true, reason: "still pressured" },
      }),
    );
    assert.strictEqual(overflow.kind, "hold");
    if (overflow.kind !== "hold") return;
    assert.strictEqual(overflow.reason, "slot_ordinal_overflow");
  });

  it("freezes decisions and ignores later caller mutation", () => {
    const mission = missionFixture();
    const safeBoundary = { ...CLEAR };
    const input = baseInput({ mission, lastSlot: null, safeBoundary });
    const decision = evaluateManagerRotation(input);
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") return;
    assert.isTrue(Object.isFrozen(decision));
    assert.isTrue(Object.isFrozen(decision.intent));

    (mission as { revision: number }).revision = 999;
    (safeBoundary as { completionRoutingReady: boolean }).completionRoutingReady = false;
    assert.strictEqual(decision.intent.observedRevision, 4);
  });
});


describe("rotation instant and authority bounds", () => {
  it.each(["2026-10-14", "2026-10-14T12:00:00", "2026-02-30T12:00:00Z"])("holds ambiguous or nonexistent instant %s", (nowIso) => {
    const decision = evaluateManagerRotation(baseInput({ nowIso }));
    assert.strictEqual(decision.kind, "hold");
    if (decision.kind === "hold") assert.strictEqual(decision.reason, "invalid_now");
  });
  it("rejects unsafe canonical revision and manager epoch", () => {
    const revisionInput = baseInput();
    const unsafeRevision = { ...revisionInput, mission: { ...revisionInput.mission, revision: Number.MAX_SAFE_INTEGER + 1 } };
    assert.strictEqual(evaluateManagerRotation(unsafeRevision).kind, "hold");
    const epochInput = baseInput();
    const unsafeEpoch = { ...epochInput, mission: { ...epochInput.mission, managers: { ...epochInput.mission.managers, delivery: { ...epochInput.mission.managers.delivery!, epoch: Number.MAX_SAFE_INTEGER + 1 } } } };
    assert.strictEqual(evaluateManagerRotation(unsafeEpoch).kind, "hold");
  });
});


describe("unknown rotation fact null guards", () => {
  const evaluateUnknown = (value: unknown) => evaluateManagerRotation(value as EvaluateManagerRotationInput);
  it.each([null, undefined])("holds non-object top-level input %s", (value) => {
    expect(evaluateUnknown(value).kind).toBe("hold");
  });
  it("holds a null manager slot", () => {
    const input = baseInput();
    const value: unknown = { ...input, mission: { ...input.mission, managers: { delivery: null } } };
    expect(evaluateUnknown(value).kind).toBe("hold");
  });
  it("holds null context-pressure facts on the current day", () => {
    const value: unknown = { ...baseInput({ lastSlot: { localDate: "2026-10-14", ordinal: 0 } }), contextPressure: null };
    expect(evaluateUnknown(value).kind).toBe("hold");
  });
});
