import {
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as ProjectionStore from "./ProjectionStore.ts";
import {
  exceededDispatchModeLimit,
  minimumDispatchModes,
  type DispatchModes,
} from "./DispatchModeLimit.ts";

export class SwarmAdmissionLost extends Schema.TaggedError<SwarmAdmissionLost>()(
  "SwarmAdmissionLost",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return "Swarm admission changed before the provider accepted this work.";
  }
}

export const swarmRunAllowed = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  thread: OrchestrationV2AppThread,
  run: OrchestrationV2Run,
  submittedModes?: DispatchModes,
) =>
  Effect.gen(function* () {
    const peer = run.swarmPeerDelivery;
    const swarmId = peer?.swarmId ?? run.swarmId;
    if (swarmId === undefined) return true;
    const currentRecipient = yield* projections.getThread(thread.id);
    const group = yield* projections.getSwarm(swarmId);
    if (group === undefined || group.lifecycle.state !== "open") return false;
    let current: ThreadId | null = thread.id;
    const visited = new Set<ThreadId>();
    let recipientAdmitted = false;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const member = group.members.find((candidate) => candidate.threadId === current);
      if (member !== undefined) {
        recipientAdmitted = member.admission.state === "admitted";
        break;
      }
      const ancestor: OrchestrationV2AppThread = yield* projections.getThread(current);
      current =
        ancestor.lineage.relationshipToParent === "subagent"
          ? ancestor.lineage.parentThreadId
          : null;
    }
    if (!recipientAdmitted) return false;
    const owner = yield* projections.getThread(group.ownerThreadId);
    if (
      owner.archivedAt !== null ||
      owner.deletedAt !== null ||
      currentRecipient.archivedAt !== null ||
      currentRecipient.deletedAt !== null
    )
      return false;
    const actual = submittedModes ?? currentRecipient;
    if (exceededDispatchModeLimit(currentRecipient, actual) !== undefined) return false;
    if (peer === undefined) {
      if (run.swarmRunAdmission === undefined)
        return exceededDispatchModeLimit(owner, actual) === undefined;
      const sender = yield* projections.getThread(run.swarmRunAdmission.senderThreadId);
      return (
        sender.archivedAt === null &&
        sender.deletedAt === null &&
        exceededDispatchModeLimit(
          minimumDispatchModes(run.swarmRunAdmission, sender, owner),
          actual,
        ) === undefined
      );
    }
    if (
      !group.members.some(
        (member) =>
          member.threadId === peer.senderThreadId && member.admission.state === "admitted",
      )
    )
      return false;
    const sender = yield* projections.getThread(peer.senderThreadId);
    const ceiling = minimumDispatchModes(peer, sender, owner);
    return (
      sender.archivedAt === null &&
      sender.deletedAt === null &&
      [owner, currentRecipient, actual].every(
        (target) => exceededDispatchModeLimit(ceiling, target) === undefined,
      )
    );
  });
