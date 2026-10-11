import type {
  OrchestrationV2Subagent,
  OrchestrationV2Swarm,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isActiveSubagentStatus, type RuntimeSubagentStatus } from "./subagentRuntime.ts";
import {
  resolveSubagentPillSegment,
  type SubagentPillSegment,
  type ThreadTurnSubagents,
} from "./threadSubagents.ts";

type ThreadSummary = OrchestrationV2ThreadShell;
const EMPTY_SWARM_GROUPS: ReadonlyArray<ThreadSwarmGroup> = Object.freeze([]);

export interface ThreadSwarmMember {
  readonly member: OrchestrationV2Swarm["members"][number];
  readonly thread: ThreadSummary | null;
  readonly task: OrchestrationV2Subagent | null;
  readonly title: string;
  readonly status: RuntimeSubagentStatus;
  readonly working: boolean;
  readonly queuedCount: number;
  readonly heldCount: number;
  readonly inputThreads: ReadonlyArray<ThreadSummary>;
  readonly canOpen: boolean;
  readonly canMessage: boolean;
  readonly canStop: boolean;
}

export interface ThreadSwarmGroup {
  readonly swarm: OrchestrationV2Swarm;
  readonly members: ReadonlyArray<ThreadSwarmMember>;
  readonly workingCount: number;
  readonly queuedCount: number;
  readonly heldCount: number;
  readonly inputCount: number;
  readonly failedCount: number;
  readonly summary: string;
}

function runtimeStatus(status: ThreadSummary["status"]): RuntimeSubagentStatus {
  switch (status) {
    case "preparing":
    case "starting":
    case "queued":
      return "pending";
    case "rolled_back":
      return "interrupted";
    default:
      return status;
  }
}

function currentTask(task: OrchestrationV2Subagent | null, thread: ThreadSummary | null) {
  if (task === null || thread === null) return task;
  const liveStatus = thread.activityRunStatus ?? (thread.status === "queued" ? "queued" : null);
  const newerRun =
    thread.latestRunRequestedAt != null &&
    DateTime.toEpochMillis(thread.latestRunRequestedAt) >
      DateTime.toEpochMillis(task.completedAt ?? task.startedAt ?? task.updatedAt);
  if (!newerRun && (liveStatus === null || isActiveSubagentStatus(task.status))) return task;
  return {
    ...task,
    status: runtimeStatus(liveStatus ?? thread.status),
    startedAt: liveStatus
      ? (thread.activityRunStartedAt ?? null)
      : (thread.latestRunStartedAt ?? null),
    completedAt: liveStatus ? null : (thread.latestRunCompletedAt ?? null),
    progress: undefined,
    result: null,
  };
}

export function filterSwarmMemberTasks<
  T extends Pick<OrchestrationV2Subagent, "origin" | "childThreadId">,
>(tasks: ReadonlyArray<T>, swarms: ReadonlyArray<OrchestrationV2Swarm>): ReadonlyArray<T> {
  const memberThreads = new Set(
    swarms.flatMap((swarm) => swarm.members.map((member) => member.threadId)),
  );
  return tasks.filter(
    (task) =>
      task.origin !== "app_owned" ||
      task.childThreadId === null ||
      !memberThreads.has(task.childThreadId),
  );
}

export function deriveThreadSwarmGroups(input: {
  readonly ownerThreadId: ThreadId;
  readonly swarms: ReadonlyArray<OrchestrationV2Swarm>;
  readonly tasks: ReadonlyArray<OrchestrationV2Subagent>;
  readonly threads: ReadonlyArray<ThreadSummary>;
}): ReadonlyArray<ThreadSwarmGroup> {
  const swarms = input.swarms.filter((swarm) => swarm.ownerThreadId === input.ownerThreadId);
  if (swarms.length === 0) return EMPTY_SWARM_GROUPS;
  const threads = new Map<ThreadId, ThreadSummary>();
  for (const thread of input.threads) {
    if (!threads.has(thread.id)) threads.set(thread.id, thread);
  }
  const children = new Map<ThreadId, ThreadSummary[]>();
  for (const thread of threads.values()) {
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null || thread.lineage.relationshipToParent !== "subagent") continue;
    const rows = children.get(parentId);
    if (rows) rows.push(thread);
    else children.set(parentId, [thread]);
  }
  const tasks = new Map<ThreadId, OrchestrationV2Subagent>();
  for (const task of input.tasks) {
    if (task.origin !== "app_owned" || task.childThreadId === null) continue;
    const previous = tasks.get(task.childThreadId);
    if (
      previous === undefined ||
      DateTime.toEpochMillis(task.startedAt ?? task.updatedAt) >=
        DateTime.toEpochMillis(previous.startedAt ?? previous.updatedAt)
    ) {
      tasks.set(task.childThreadId, task);
    }
  }
  return swarms.map((swarm) => {
    const members = swarm.members.map((member): ThreadSwarmMember => {
      const thread = threads.get(member.threadId) ?? null;
      const task = currentTask(
        tasks.get(member.threadId) ?? input.tasks.find((row) => row.id === member.taskId) ?? null,
        thread,
      );
      const subtree: ThreadSummary[] = [];
      const seen = new Set<ThreadId>();
      const pending = [member.threadId];
      for (const id of pending) {
        if (seen.has(id)) continue;
        seen.add(id);
        const row = threads.get(id);
        if (row) subtree.push(row);
        for (const child of children.get(id) ?? []) pending.push(child.id);
      }
      const inputThreads = subtree.filter(
        (row) =>
          row.pendingRuntimeRequest?.kind === "user_input" && !isProviderNativeSubagentThread(row),
      );
      const queuedCount = subtree.reduce((count, row) => count + (row.queuedMessageCount ?? 0), 0);
      const heldCount = subtree.reduce(
        (count, row) => count + (row.heldQueuedMessageCount ?? 0),
        0,
      );
      const taskIsNewer =
        task !== null &&
        thread?.latestRunRequestedAt != null &&
        DateTime.toEpochMillis(task.startedAt ?? task.updatedAt) >
          DateTime.toEpochMillis(thread.latestRunRequestedAt);
      const status =
        thread === null || taskIsNewer
          ? (task?.status ?? "pending")
          : runtimeStatus(thread.activityRunStatus ?? thread.status);
      const working =
        subtree.some(
          (row) =>
            row.activityRunStatus != null ||
            ["preparing", "starting", "running", "waiting"].includes(row.status) ||
            (row.status === "queued" &&
              (row.queuedMessageCount ?? 0) > (row.heldQueuedMessageCount ?? 0)),
        ) ||
        ((thread === null || taskIsNewer) && task !== null && isActiveSubagentStatus(task.status));
      const canOpen = thread !== null && thread.deletedAt === null;
      const canMessage =
        canOpen && thread.archivedAt === null && !isProviderNativeSubagentThread(thread);
      return {
        member,
        thread,
        task,
        title: member.title || thread?.title || task?.title || member.threadId,
        status,
        working,
        queuedCount,
        heldCount,
        inputThreads,
        canOpen,
        canMessage,
        canStop: canMessage && (working || queuedCount > 0),
      };
    });
    const workingCount = members.filter((member) => member.working).length;
    const queuedCount = members.reduce((count, member) => count + member.queuedCount, 0);
    const heldCount = members.reduce((count, member) => count + member.heldCount, 0);
    const inputCount = new Set(
      members.flatMap((member) => member.inputThreads.map((thread) => thread.id)),
    ).size;
    const failedCount = members.filter((member) => member.status === "failed").length;
    const summary = [
      swarm.lifecycle.state === "closed"
        ? "Closed"
        : workingCount === 0 && queuedCount === 0 && inputCount === 0
          ? "Idle"
          : null,
      inputCount > 0 ? `${inputCount} ${inputCount === 1 ? "question" : "questions"}` : null,
      workingCount > 0 ? `${workingCount} working` : null,
      queuedCount > 0 ? `${queuedCount} queued${heldCount > 0 ? `, ${heldCount} held` : ""}` : null,
      failedCount > 0 ? `${failedCount} failed` : null,
    ]
      .filter((part) => part !== null)
      .join(" · ");
    return {
      swarm,
      members,
      workingCount,
      queuedCount,
      heldCount,
      inputCount,
      failedCount,
      summary,
    };
  });
}

export function resolveThreadAgentsPillSegment(input: {
  readonly turn: ThreadTurnSubagents | null;
  readonly groups: ReadonlyArray<ThreadSwarmGroup>;
}): SubagentPillSegment | null {
  if (input.groups.length === 0) return resolveSubagentPillSegment(input.turn);
  const swarms = input.groups.map((group) => group.swarm);
  const ordinary = filterSwarmMemberTasks(input.turn?.subagents ?? [], swarms);
  const members = new Set(
    swarms.flatMap((swarm) => swarm.members.map((member) => member.threadId)),
  );
  const total = members.size + ordinary.length;
  const live =
    input.groups.reduce((count, group) => count + group.workingCount, 0) +
    ordinary.filter((task) => isActiveSubagentStatus(task.status)).length;
  return {
    label: live > 0 ? `${live}/${total}` : "Agents",
    accessibilityLabel:
      live > 0
        ? `${live} of ${total} agents working`
        : `Inspect ${total} agents, including previous swarms`,
  };
}
