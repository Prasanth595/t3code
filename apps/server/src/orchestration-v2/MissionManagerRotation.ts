import type { Mission, MissionStatus } from "../../../../packages/contracts/src/mission.ts";

/**
 * Pure source-side manager-rotation boundary evaluator (P3 planning slice).
 *
 * Deterministic and side-effect-free: given the canonical Mission, an
 * explicit manager role, an explicit project IANA timezone, a captured
 * current timestamp, last durable slot facts supplied by the caller, an
 * optional context-pressure request, and captured safe-boundary facts, it
 * returns a prepared decision ONLY. It never launches threads, reserves
 * successor intents, dispatches work, releases sessions, or grants GUI
 * leases; durable successor intent / CAS / standby / bootstrap / routing /
 * teardown remain parent follow-up.
 *
 * Unknown, absent, invalid, or ambiguous configuration or observed state
 * always yields HOLD, never permission.
 */

/** Logical manager role under rotation. Mirrors the mission manager slots. */
export type ManagerRotationRole = "delivery" | "retro";

/** Last durable slot facts supplied by the caller. Null means no slot yet. */
export interface LastRotationSlot {
  /** Calendar day of the last durable slot, YYYY-MM-DD in project time. */
  readonly localDate: string;
  /** Same-day ordinal of the last durable slot. */
  readonly ordinal: number;
}

/** Optional context-pressure handoff request for the current day. */
export interface ContextPressureRequest {
  readonly requested: boolean;
  readonly reason?: string | undefined;
}

/**
 * Captured safe-boundary facts. Every flag must be an explicit boolean;
 * non-boolean (unknown) input holds the rotation.
 */
export interface RotationSafeBoundary {
  /** A critical incumbent integration is still running. */
  readonly incumbentIntegrationRunning: boolean;
  /** The incumbent holds GUI ownership or a GUI action is in flight. */
  readonly incumbentGuiOwned: boolean;
  /** An unresolved arbitrary-shell or shared write exists. */
  readonly unresolvedShellWrite: boolean;
  /** It is unknown whether shared writes can continue. */
  readonly sharedWriteUnknown: boolean;
  /** Quiescence is unknown. */
  readonly quiescenceUnknown: boolean;
  /** Independently owned child workers are still outstanding. */
  readonly childWorkersPending: boolean;
  /**
   * Role-aware completion routing readiness is positively proven. Unknown
   * or false (including legacy parentThreadId-only routing) holds.
   */
  readonly completionRoutingReady: boolean;
}

export interface EvaluateManagerRotationInput {
  readonly mission: Mission;
  readonly role: ManagerRotationRole;
  /** Explicit project IANA timezone. Required; never defaulted. */
  readonly projectTimezone: string | undefined;
  /** Captured current instant, ISO-8601. Required; never read from a clock. */
  readonly nowIso: string;
  /** Last durable slot facts, or null when no slot exists yet. */
  readonly lastSlot: LastRotationSlot | null;
  readonly contextPressure?: ContextPressureRequest | undefined;
  readonly safeBoundary: RotationSafeBoundary;
  /**
   * Queued retro items awaiting the retro role. Required for role "retro";
   * ignored for role "delivery".
   */
  readonly retroQueueDepth?: number | undefined;
  readonly userStopRequested: boolean;
  readonly userPauseRequested: boolean;
}

export type RotationDueReason = "first_slot" | "new_local_day" | "context_pressure";

export type RotationNoopReason =
  | "same_day"
  | "mission_inactive"
  | "user_stop"
  | "user_pause"
  | "empty_retro_queue";

export type RotationHoldReason =
  | "missing_timezone"
  | "invalid_timezone"
  | "invalid_now"
  | "invalid_role"
  | "invalid_revision"
  | "missing_manager"
  | "unknown_user_intent"
  | "unknown_retro_queue"
  | "invalid_retro_queue"
  | "invalid_slot_day"
  | "future_slot"
  | "invalid_slot_ordinal"
  | "slot_ordinal_overflow"
  | "missing_context_reason"
  | "unknown_safe_boundary"
  | "incumbent_integration"
  | "gui_ownership"
  | "unresolved_shell_write"
  | "unknown_shared_write"
  | "unknown_quiescence"
  | "completion_routing_unconfirmed";

/**
 * Frozen prepared rotation intent. Carries identity and boundary facts for
 * a later durable reserve; standby/successor readiness is NOT active
 * authority and no successor thread is derived here.
 */
export interface PreparedRotationIntent {
  readonly missionId: string;
  readonly observedRevision: number;
  readonly role: ManagerRotationRole;
  readonly currentThreadId: string;
  readonly currentEpoch: number;
  readonly timezone: string;
  readonly localDate: string;
  readonly ordinal: number;
  readonly reason: RotationDueReason;
}

export type ManagerRotationDecision =
  | {
      readonly kind: "rotate";
      readonly intent: PreparedRotationIntent;
    }
  | {
      readonly kind: "noop";
      readonly missionId: string;
      readonly role: ManagerRotationRole;
      readonly reason: RotationNoopReason;
      readonly detail: string;
    }
  | {
      readonly kind: "hold";
      readonly missionId: string;
      readonly role: ManagerRotationRole;
      readonly reason: RotationHoldReason;
      readonly detail: string;
    };

/** Largest same-day ordinal this evaluator will prepare. Next wins overflow. */
export const MAX_SAME_DAY_ORDINAL = 8;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const STATUSES: ReadonlySet<MissionStatus> = new Set(["active", "paused", "completed", "stopped"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      ? 29
      : 28
    : month === 4 || month === 6 || month === 9 || month === 11
      ? 30
      : 31;

const isCalendarDate = (localDate: string): boolean => {
  const match = LOCAL_DATE_PATTERN.exec(localDate);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return (
    Number.isInteger(year) &&
    year >= 1 &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
};

const parseCapturedInstant = (value: string): number => {
  // Require an explicit offset and a real calendar date; Date.parse alone
  // accepts host-local timestamps and normalizes impossible dates.
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (parts === null || !isCalendarDate(parts[1]!) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return Number.NaN;
  return Date.parse(value);
};

const isValidTimezone = (timezone: string): boolean => {
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) return false;
  try {
    const probe = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return probe.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
};

/** Calendar localDate (YYYY-MM-DD) of an instant in an explicit IANA zone. */
const toLocalDate = (instantMs: number, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instantMs);
  const byType = new Map(parts.map((part) => [part.type, part.value] as const));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
};

const freezeDecision = (decision: ManagerRotationDecision): ManagerRotationDecision => {
  if (decision.kind === "rotate") Object.freeze(decision.intent);
  return Object.freeze(decision);
};

const hold = (
  missionId: string,
  role: ManagerRotationRole,
  reason: RotationHoldReason,
  detail: string,
): ManagerRotationDecision => freezeDecision({ kind: "hold", missionId, role, reason, detail });

const noop = (
  missionId: string,
  role: ManagerRotationRole,
  reason: RotationNoopReason,
  detail: string,
): ManagerRotationDecision => freezeDecision({ kind: "noop", missionId, role, reason, detail });

/**
 * Evaluate the manager-rotation boundary. Pure: no I/O, no clock reads,
 * no retained references to caller-owned objects (only primitives cross
 * the boundary, and every returned object is frozen).
 */
export const evaluateManagerRotation = (
  input: EvaluateManagerRotationInput,
): ManagerRotationDecision => {
  const missionId =
    isRecord(input) && typeof input.mission?.id === "string" ? input.mission.id : "unknown";
  const role = (input as { role?: unknown }).role;
  if (role !== "delivery" && role !== "retro") {
    return hold(missionId, "delivery", "invalid_role", "Manager role must be delivery or retro.");
  }

  const timezone = (input as { projectTimezone?: unknown }).projectTimezone;
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    return hold(missionId, role, "missing_timezone", "An explicit project IANA timezone is required.");
  }
  if (!isValidTimezone(timezone)) {
    return hold(
      missionId,
      role,
      "invalid_timezone",
      `Project timezone '${timezone}' is not a known IANA zone.`,
    );
  }

  const nowMs =
    typeof input.nowIso === "string" ? parseCapturedInstant(input.nowIso) : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    return hold(missionId, role, "invalid_now", "Captured current timestamp is not a valid instant.");
  }

  const mission = input.mission;
  if (
    !isRecord(mission) ||
    typeof mission.revision !== "number" ||
    !Number.isSafeInteger(mission.revision) ||
    mission.revision < 0
  ) {
    return hold(missionId, role, "invalid_revision", "Mission revision is not a valid ordinal.");
  }
  if (!STATUSES.has(mission.status)) {
    return hold(missionId, role, "invalid_revision", "Mission status is not a canonical status.");
  }

  const assignment =
    role === "delivery" ? mission.managers?.delivery : mission.managers?.retro;
  if (
    assignment === undefined ||
    typeof assignment.threadId !== "string" ||
    assignment.threadId.length === 0 ||
    typeof assignment.epoch !== "number" ||
    !Number.isSafeInteger(assignment.epoch) ||
    assignment.epoch < 0
  ) {
    return hold(
      missionId,
      role,
      "missing_manager",
      `No bound ${role} manager thread and epoch on the canonical mission.`,
    );
  }

  if (
    typeof input.userStopRequested !== "boolean" ||
    typeof input.userPauseRequested !== "boolean"
  ) {
    return hold(missionId, role, "unknown_user_intent", "User stop/pause state is unknown.");
  }

  if (role === "retro") {
    if (input.retroQueueDepth === undefined) {
      return hold(missionId, role, "unknown_retro_queue", "Retro queue depth is unknown.");
    }
    if (
      typeof input.retroQueueDepth !== "number" ||
      !Number.isSafeInteger(input.retroQueueDepth) ||
      input.retroQueueDepth < 0
    ) {
      return hold(missionId, role, "invalid_retro_queue", "Retro queue depth is not a valid count.");
    }
  }

  const boundary = input.safeBoundary;
  const boundaryFlags: ReadonlyArray<keyof RotationSafeBoundary> = [
    "incumbentIntegrationRunning",
    "incumbentGuiOwned",
    "unresolvedShellWrite",
    "sharedWriteUnknown",
    "quiescenceUnknown",
    "childWorkersPending",
    "completionRoutingReady",
  ];
  if (
    !isRecord(boundary) ||
    boundaryFlags.some((flag) => typeof boundary[flag] !== "boolean")
  ) {
    return hold(missionId, role, "unknown_safe_boundary", "Safe-boundary facts are unknown.");
  }

  const today = toLocalDate(nowMs, timezone);
  if (!isCalendarDate(today)) return hold(missionId, role, "invalid_now", "Captured instant is outside the supported calendar range.");

  const lastSlot = input.lastSlot;
  if (lastSlot !== null) {
    if (!isRecord(lastSlot) || typeof lastSlot.localDate !== "string") {
      return hold(missionId, role, "invalid_slot_day", "Last slot day is not a calendar date.");
    }
  }

  // Stable no-rotation states: evaluated before any boundary so an inactive
  // mission, an explicit user stop/pause, or an empty retro queue never
  // rotates regardless of calendar or safety posture.
  if (mission.status !== "active") {
    return noop(
      missionId,
      role,
      "mission_inactive",
      `Mission is ${mission.status}; inactive missions never rotate.`,
    );
  }
  if (input.userStopRequested) {
    return noop(missionId, role, "user_stop", "Explicit user stop wins over rotation.");
  }
  if (input.userPauseRequested) {
    return noop(missionId, role, "user_pause", "Explicit user pause wins over rotation.");
  }
  if (role === "retro" && input.retroQueueDepth === 0) {
    return noop(missionId, role, "empty_retro_queue", "Retro queue is empty; no session to rotate.");
  }

  let localDate: string;
  let ordinal: number;
  let reason: RotationDueReason;

  if (lastSlot === null) {
    localDate = today;
    ordinal = 0;
    reason = "first_slot";
  } else {
    if (!isCalendarDate(lastSlot.localDate)) {
      return hold(
        missionId,
        role,
        "invalid_slot_day",
        `Last slot day '${lastSlot.localDate}' is not a calendar date.`,
      );
    }
    if (lastSlot.localDate > today) {
      return hold(
        missionId,
        role,
        "future_slot",
        `Last slot day '${lastSlot.localDate}' is after today '${today}'.`,
      );
    }
    if (
      typeof lastSlot.ordinal !== "number" ||
      !Number.isInteger(lastSlot.ordinal) ||
      lastSlot.ordinal < 0 ||
      lastSlot.ordinal > MAX_SAME_DAY_ORDINAL
    ) {
      return hold(
        missionId,
        role,
        "invalid_slot_ordinal",
        "Last slot ordinal is outside finite safe bounds.",
      );
    }
    if (lastSlot.localDate < today) {
      // Skipped offline days plan today's needed slot only: no backlog.
      localDate = today;
      ordinal = 0;
      reason = "new_local_day";
    } else if (
      input.contextPressure !== undefined &&
      input.contextPressure.requested === true
    ) {
      if (
        typeof input.contextPressure.reason !== "string" ||
        input.contextPressure.reason.trim().length === 0
      ) {
        return hold(
          missionId,
          role,
          "missing_context_reason",
          "Context-pressure rotation needs an explicit reason.",
        );
      }
      if (lastSlot.ordinal + 1 > MAX_SAME_DAY_ORDINAL) {
        return hold(
          missionId,
          role,
          "slot_ordinal_overflow",
          "Same-day rotation ordinal would exceed its bound.",
        );
      }
      localDate = today;
      ordinal = lastSlot.ordinal + 1;
      reason = "context_pressure";
    } else {
      return noop(missionId, role, "same_day", "Same local day normally needs no rotation.");
    }
  }

  // Safe boundary: any unsafe or unknown condition holds. Independently
  // owned child workers alone do not block once role-aware completion
  // routing is positively proven.
  if (boundary.incumbentIntegrationRunning) {
    return hold(missionId, role, "incumbent_integration", "A critical incumbent integration is running.");
  }
  if (boundary.incumbentGuiOwned) {
    return hold(missionId, role, "gui_ownership", "The incumbent still owns GUI state.");
  }
  if (boundary.unresolvedShellWrite) {
    return hold(
      missionId,
      role,
      "unresolved_shell_write",
      "An unresolved arbitrary-shell or shared write exists.",
    );
  }
  if (boundary.sharedWriteUnknown) {
    return hold(missionId, role, "unknown_shared_write", "Shared-write state is unknown.");
  }
  if (boundary.quiescenceUnknown) {
    return hold(missionId, role, "unknown_quiescence", "Quiescence is unknown.");
  }
  if (!boundary.completionRoutingReady) {
    return hold(
      missionId,
      role,
      "completion_routing_unconfirmed",
      "Role-aware completion routing is unconfirmed.",
    );
  }

  return freezeDecision({
    kind: "rotate",
    intent: {
      missionId: mission.id,
      observedRevision: mission.revision,
      role,
      currentThreadId: assignment.threadId,
      currentEpoch: assignment.epoch,
      timezone,
      localDate,
      ordinal,
      reason,
    },
  });
};
