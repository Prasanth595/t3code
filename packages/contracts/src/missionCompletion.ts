import * as Schema from "effect/Schema";

/**
 * Canonical minimal completion-route-read selector wire schemas.
 *
 * A selector is a lookup key only, never proof: kind plus the exact
 * persisted identity fields the private SQL-backed completion reference
 * producer rederives from the actual canonical mission row. It carries no
 * alleged scope, team, role, epoch, provenance, lease, hash, or body, and
 * the owning authority derives the required canonical role from `kind`
 * (task-result requires delivery, retro-report requires retro) instead of
 * trusting any caller claim.
 *
 * Known strict subset: `RetroId` (`missionRetro.ts`) accepts up to 256
 * characters, while these selectors stay at the 128-character compact
 * ASCII bound enforced by the private completion validator
 * (`MissionManagerHandoff.isHandoffSafeId`). A 129-256 character retro
 * checkpoint or mission id is a valid `RetroId` but never a valid
 * completion selector; completion reads reject it before any record I/O.
 *
 * Leaf schemas and small bounds only: no server imports, no policy or
 * registry access, no heavy logic. This module registers nothing.
 */

/** Compact ASCII metadata id: 1-128 chars of `[A-Za-z0-9_.:-]`, no paths or controls. */
const CompletionSelectorId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 128 &&
      /^[A-Za-z0-9_.:-]+$/.test(value),
    { expected: "a compact ASCII id of 1-128 [A-Za-z0-9_.:-] characters" },
  ),
);

/** Nonnegative safe-integer counter (attempt numbers, result revisions). */
const CompletionCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0, {
    expected: "a nonnegative safe integer",
  }),
);

/** Positive safe-integer counter (retro report revisions start at 1). */
const CompletionPositiveCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0, {
    expected: "a positive safe integer",
  }),
);

/** Key for one persisted task-result record: task plus attempt plus revision. */
export const MissionCompletionTaskResultSelector = Schema.Struct({
  kind: Schema.Literal("task-result"),
  missionId: CompletionSelectorId,
  taskId: CompletionSelectorId,
  attemptNumber: CompletionCounter,
  resultRevision: CompletionCounter,
});
export type MissionCompletionTaskResultSelector =
  typeof MissionCompletionTaskResultSelector.Type;

/** Key for one persisted retro-report receipt: checkpoint plus revision. */
export const MissionCompletionRetroReportSelector = Schema.Struct({
  kind: Schema.Literal("retro-report"),
  missionId: CompletionSelectorId,
  checkpointId: CompletionSelectorId,
  reportRevision: CompletionPositiveCounter,
});
export type MissionCompletionRetroReportSelector =
  typeof MissionCompletionRetroReportSelector.Type;

/**
 * Canonical minimal completion selector union. Decode with
 * `onExcessProperty: "error"` so alleged scope, role, epoch, or proof
 * fields never ride along with a key.
 */
export const MissionCompletionSelector = Schema.Union([
  MissionCompletionTaskResultSelector,
  MissionCompletionRetroReportSelector,
]);
export type MissionCompletionSelector = typeof MissionCompletionSelector.Type;

/** Strict effect decoder: excess properties fail, never pass through. */
export const decodeMissionCompletionSelector = Schema.decodeUnknownEffect(
  MissionCompletionSelector,
  { onExcessProperty: "error" },
);
