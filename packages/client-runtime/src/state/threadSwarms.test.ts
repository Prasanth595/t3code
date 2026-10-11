import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  SwarmId,
  ThreadId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadStreamItem,
  type OrchestrationV2Subagent,
  type OrchestrationV2Swarm,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  deriveThreadSwarmGroups,
  filterSwarmMemberTasks,
  resolveThreadAgentsPillSegment,
} from "./threadSwarms.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const owner = v2Projection.thread.id;
const a = ThreadId.make("member-a");
const b = ThreadId.make("member-b");
const later = DateTime.makeUnsafe("2026-06-20T00:01:00.000Z");
const backgroundAt = DateTime.makeUnsafe("2026-06-20T00:02:00.000Z");
const decodeProjection = Schema.decodeSync(OrchestrationV2ThreadProjection);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShell);
const decodeStreamItems = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.Array(OrchestrationV2ThreadStreamItem)),
);
function swarm(overrides: Partial<OrchestrationV2Swarm> = {}): OrchestrationV2Swarm {
  return {
    id: SwarmId.make("swarm-review"),
    ownerThreadId: owner,
    ownerRunId: RunId.make("owner-run"),
    creationCommandId: CommandId.make("create-review"),
    title: "Review",
    lifecycle: { state: "open" },
    members: [
      {
        threadId: a,
        taskId: NodeId.make("task-a"),
        title: "API",
        admission: { state: "admitted" },
      },
      { threadId: b, taskId: NodeId.make("task-b"), title: "UI", admission: { state: "admitted" } },
    ],
    createdAt: v2Now,
    updatedAt: v2Now,
    ...overrides,
  };
}
function shell(
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id,
    title: id,
    lineage: { rootThreadId: owner, parentThreadId: owner, relationshipToParent: "subagent" },
    ...overrides,
  };
}
function task(
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(threadId === a ? "task-a" : "task-b"),
    threadId: owner,
    runId: RunId.make("owner-run"),
    parentNodeId: NodeId.make("owner-node"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: threadId,
    nativeTaskRef: null,
    prompt: "Review the change",
    title: "Review",
    model: "gpt-5.4",
    status: "completed",
    result: "Original result",
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
    ...overrides,
  };
}

describe("thread swarm groups", () => {
  const backgroundCases = [
    { kind: "command", working: false, title: "Running a command" },
    { kind: "subagent", working: true, title: "Waiting on a subagent" },
    { kind: "background_task", working: true, title: "Waiting on a background task" },
    { kind: "monitor", working: true, title: "Waiting on a monitor" },
  ] satisfies ReadonlyArray<{
    kind: OrchestrationV2PendingBackgroundTask["kind"];
    working: boolean;
    title: string;
  }>;

  it.each(
    backgroundCases.flatMap((work) =>
      [false, true].flatMap((closed) =>
        [false, true].map((descendant) => ({ ...work, closed, descendant })),
      ),
    ),
  )(
    "keeps background $kind actionable, closed=$closed descendant=$descendant",
    ({ kind, working, title, closed, descendant }) => {
      const group = closed
        ? swarm({
            lifecycle: { state: "closed", closedAt: later },
            members: swarm().members.map((member) => ({
              ...member,
              admission: { state: "revoked", revokedAt: later },
            })),
          })
        : swarm();
      const backgroundThreadId = descendant ? ThreadId.make("background-descendant") : a;
      const backgroundThread = shell(backgroundThreadId, {
        status: "completed",
        activeRunId: null,
        activityRunStatus: null,
        activeProviderThreadId: ProviderThreadId.make("background-provider-thread"),
        latestRunId: RunId.make("later-human-run"),
        latestRunRequestedAt: backgroundAt,
        latestRunStartedAt: backgroundAt,
        latestRunCompletedAt: backgroundAt,
        pendingBackgroundTasks: [{ taskId: "native-work", kind }],
        lineage: {
          rootThreadId: owner,
          parentThreadId: descendant ? a : owner,
          relationshipToParent: "subagent",
        },
      });
      const groups = deriveThreadSwarmGroups({
        ownerThreadId: owner,
        swarms: [group],
        tasks: [task(a), task(b)],
        threads: [
          ...(descendant ? [shell(a, { status: "completed" })] : []),
          backgroundThread,
          shell(b),
        ],
      });
      const member = groups[0]?.members[0];
      expect({
        canStop: member?.canStop,
        working: member?.working,
        status: member?.status,
        background: member?.backgroundWork?.title,
        waiting: member?.backgroundWork?.waiting,
        count: groups[0]?.backgroundCount,
        summary: groups[0]?.summary,
        admission: member?.member.admission.state,
      }).toEqual({
        canStop: true,
        working,
        status: "completed",
        background: title,
        waiting: working,
        count: 1,
        summary: `${closed ? "Closed" : working ? "1 working" : "Idle"}${closed && working ? " · 1 working" : ""} · 1 background`,
        admission: closed ? "revoked" : "admitted",
      });
      expect(resolveThreadAgentsPillSegment({ turn: null, groups })).toEqual(
        working
          ? { label: "1/2", accessibilityLabel: "1 of 2 agents working" }
          : { label: "Agents", accessibilityLabel: "Inspect 2 agents, including previous swarms" },
      );
      expect(group.lifecycle.state).toBe(closed ? "closed" : "open");
      const settled = deriveThreadSwarmGroups({
        ownerThreadId: owner,
        swarms: [group],
        tasks: [task(a), task(b)],
        threads: [shell(a, { status: "completed", pendingBackgroundTasks: [] }), shell(b)],
      });
      expect({
        stop: settled[0]?.members[0]?.canStop,
        background: settled[0]?.members[0]?.backgroundWork,
        working: settled[0]?.workingCount,
        summary: settled[0]?.summary,
      }).toEqual({
        stop: false,
        background: null,
        working: 0,
        summary: closed ? "Closed" : "Idle",
      });
    },
  );

  it("keeps completion-holding background attention ahead of held queues and idle commands", () => {
    const definitions = [
      { id: "command", kind: "command", closed: false },
      { id: "closed-command", kind: "command", closed: true },
      { id: "monitor", kind: "monitor", closed: true },
      { id: "subagent", kind: "subagent", closed: false },
      { id: "background-task", kind: "background_task", closed: false },
    ] satisfies ReadonlyArray<{
      id: string;
      kind: OrchestrationV2PendingBackgroundTask["kind"];
      closed: boolean;
    }>;
    const groups = definitions.map(({ id, closed }) =>
      swarm({
        id: SwarmId.make(id),
        lifecycle: closed ? { state: "closed", closedAt: later } : { state: "open" },
        members: swarm().members.map((member, index) => ({
          ...member,
          threadId: ThreadId.make(`${id}-${index}`),
        })),
      }),
    );
    const held = swarm({ id: SwarmId.make("held"), createdAt: later });
    const question = swarm({
      id: SwarmId.make("question"),
      members: swarm().members.map((member, index) => ({
        ...member,
        threadId: ThreadId.make(`question-${index}`),
      })),
    });
    const threads = definitions.map(({ id, kind }) =>
      shell(ThreadId.make(`${id}-0`), {
        status: "completed",
        pendingBackgroundTasks: [{ taskId: "work", kind }],
      }),
    );
    const derived = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [...groups, held, question],
      tasks: [],
      threads: [
        ...threads,
        shell(a, { status: "queued", queuedMessageCount: 1, heldQueuedMessageCount: 1 }),
        shell(b),
        shell(ThreadId.make("question-0"), {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input",
            createdAt: later,
          },
        }),
      ],
    });
    expect(derived.map((row) => row.swarm.id)).toEqual([
      "question",
      "background-task",
      "monitor",
      "subagent",
      "held",
      "command",
      "closed-command",
    ]);
  });

  it("counts each background subtree once and keeps commands separate from completion-holding attention", () => {
    const descendant = shell(ThreadId.make("background-descendant"), {
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "same-local-id", kind: "monitor" }],
      lineage: { rootThreadId: owner, parentThreadId: a, relationshipToParent: "subagent" },
    });
    const groups = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm()],
      tasks: [],
      threads: [
        shell(a, {
          status: "completed",
          pendingBackgroundTasks: [{ taskId: "same-local-id", kind: "command" }],
        }),
        shell(b),
        descendant,
        descendant,
      ],
    });
    expect({
      working: groups[0]?.workingCount,
      background: groups[0]?.backgroundCount,
      summary: groups[0]?.summary,
    }).toEqual({
      working: 1,
      background: 2,
      summary: "1 working · 2 background",
    });
    expect(groups[0]?.members[0]?.backgroundWork?.title).toBe("Waiting on 1 command and 1 monitor");
  });

  it.each([
    { name: "archived", overrides: { archivedAt: later } },
    { name: "deleted", overrides: { deletedAt: later } },
    { name: "provider-owned", overrides: { creationSource: "provider" as const } },
  ])("keeps background work from enabling member controls for $name threads", ({ overrides }) => {
    const groups = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm()],
      tasks: [],
      threads: [
        shell(a, {
          status: "completed",
          pendingBackgroundTasks: [{ taskId: "work", kind: "monitor" }],
          ...overrides,
        }),
        shell(b),
      ],
    });
    expect({
      stop: groups[0]?.members[0]?.canStop,
      message: groups[0]?.members[0]?.canMessage,
      background: groups[0]?.backgroundCount,
    }).toEqual({ stop: false, message: false, background: 1 });
  });

  it("counts member threads once, follows current work and removes every followup task from ordinary rows", () => {
    const tasks = [
      task(a),
      task(b),
      task(a, {
        id: NodeId.make("followup-a"),
        status: "running",
        startedAt: later,
        completedAt: null,
        progress: "Checking API",
        result: null,
      }),
      task(ThreadId.make("ordinary"), { id: NodeId.make("ordinary-task") }),
    ];
    const groups = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm()],
      tasks,
      threads: [
        shell(a, {
          status: "running",
          activityRunStatus: "running",
          latestRunRequestedAt: later,
          queuedMessageCount: 2,
          heldQueuedMessageCount: 1,
        }),
        shell(b),
      ],
    });
    expect(
      groups.map((group) => ({
        members: group.members.map((member) => member.member.threadId),
        working: group.workingCount,
        queued: group.queuedCount,
        held: group.heldCount,
        summary: group.summary,
      })),
    ).toEqual([
      {
        members: ["member-a", "member-b"],
        working: 1,
        queued: 2,
        held: 1,
        summary: "1 working · 2 queued, 1 held",
      },
    ]);
    expect(groups[0]?.members[0]?.task?.id).toBe("followup-a");
    expect(groups[0]?.members[0]?.task?.progress).toBe("Checking API");
    expect(filterSwarmMemberTasks(tasks, [swarm()]).map((row) => row.id)).toEqual([
      "ordinary-task",
    ]);
    expect(filterSwarmMemberTasks(tasks, []).map((row) => row.id)).toEqual([
      "task-a",
      "task-b",
      "followup-a",
      "ordinary-task",
    ]);
  });

  it("shows newer ordinary work on a closed revoked member without reopening access or showing an old result", () => {
    const closed = swarm({
      lifecycle: { state: "closed", closedAt: later },
      members: swarm().members.map((member) => ({
        ...member,
        admission: { state: "revoked", revokedAt: later },
      })),
    });
    const group = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [closed],
      tasks: [task(a), task(b)],
      threads: [
        shell(a, { status: "running", activityRunStatus: "running", latestRunRequestedAt: later }),
        shell(b),
      ],
    })[0];
    expect({
      lifecycle: group?.swarm.lifecycle.state,
      summary: group?.summary,
      admission: group?.members[0]?.member.admission.state,
      result: group?.members[0]?.task?.result,
      canMessage: group?.members[0]?.canMessage,
    }).toEqual({
      lifecycle: "closed",
      summary: "Closed · 1 working",
      admission: "revoked",
      result: null,
      canMessage: true,
    });
    const idle = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm()],
      tasks: [task(a), task(b)],
      threads: [shell(a), shell(b)],
    })[0];
    expect(idle?.summary).toBe("Idle");
  });

  it("keeps descendant question attention in the collapsed summary and ignores provider-owned questions", () => {
    const grandchild = ThreadId.make("question-child");
    const request = {
      id: RuntimeRequestId.make("question"),
      kind: "user_input" as const,
      createdAt: later,
    };
    const group = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm()],
      tasks: [],
      threads: [
        shell(a),
        shell(b),
        shell(grandchild, {
          pendingRuntimeRequest: request,
          lineage: { rootThreadId: owner, parentThreadId: a, relationshipToParent: "subagent" },
        }),
        shell(ThreadId.make("native"), {
          creationSource: "provider",
          pendingRuntimeRequest: request,
          lineage: { rootThreadId: owner, parentThreadId: a, relationshipToParent: "subagent" },
        }),
      ],
    })[0];
    expect({
      summary: group?.summary,
      inputs: group?.members.flatMap((member) => member.inputThreads.map((thread) => thread.id)),
    }).toEqual({ summary: "1 question", inputs: ["question-child"] });
  });

  it("retains missing, failed and archived members and keeps the historical Agents entry through an unrelated later turn", () => {
    const groups = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm({ lifecycle: { state: "closed", closedAt: later } })],
      tasks: [task(a, { status: "failed", result: "Startup failed" }), task(b)],
      threads: [shell(b, { archivedAt: later })],
    });
    expect(
      groups[0]?.members.map((member) => ({
        id: member.member.threadId,
        status: member.status,
        open: member.canOpen,
        message: member.canMessage,
        result: member.task?.result,
      })),
    ).toEqual([
      { id: "member-a", status: "failed", open: false, message: false, result: "Startup failed" },
      { id: "member-b", status: "idle", open: true, message: false, result: "Original result" },
    ]);
    expect(resolveThreadAgentsPillSegment({ turn: null, groups })).toEqual({
      label: "Agents",
      accessibilityLabel: "Inspect 2 agents, including previous swarms",
    });
    expect(
      resolveThreadAgentsPillSegment({
        turn: {
          runId: RunId.make("later-owner-run"),
          turnActive: false,
          subagents: [],
          liveCount: 0,
          settledCount: 0,
        },
        groups,
      }),
    ).toEqual({
      label: "Agents",
      accessibilityLabel: "Inspect 2 agents, including previous swarms",
    });
    expect(resolveThreadAgentsPillSegment({ turn: null, groups: [] })).toBeNull();
  });

  it("does not count held-only queues as working or let an archived stale shell replace a live shell", () => {
    const group = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [swarm()],
      tasks: [],
      threads: [
        shell(a, { status: "queued", queuedMessageCount: 1, heldQueuedMessageCount: 1 }),
        shell(b),
        shell(b, { status: "running", archivedAt: later }),
      ],
    })[0];
    expect({
      working: group?.workingCount,
      queued: group?.queuedCount,
      summary: group?.summary,
      message: group?.members[1]?.canMessage,
    }).toEqual({ working: 0, queued: 1, summary: "1 queued, 1 held", message: true });
  });

  it("orders current attention before paginated history, with held queues ahead of idle groups", () => {
    const group = (id: string, minute: number, closed = false) =>
      swarm({
        id: SwarmId.make(id),
        createdAt: DateTime.makeUnsafe(`2026-06-20T00:${String(minute).padStart(2, "0")}:00Z`),
        lifecycle: closed ? { state: "closed", closedAt: later } : { state: "open" },
        members: swarm().members.map((member, index) => ({
          ...member,
          threadId: ThreadId.make(`${id}-${index}`),
        })),
      });
    const history = Array.from({ length: 10 }, (_, index) =>
      group(`history-${index}`, index, true),
    );
    const current = [
      group("idle", 30),
      group("held", 31, true),
      group("work", 32, true),
      group("queue", 33),
      group("question", 34),
      group("idle-older", 29),
    ];
    const child = ThreadId.make("question-descendant");
    const threads = [...history, ...current].flatMap((row) =>
      row.members.map((member) => shell(member.threadId)),
    );
    threads.push(
      shell(ThreadId.make("held-0"), {
        status: "queued",
        queuedMessageCount: 2,
        heldQueuedMessageCount: 2,
      }),
      shell(ThreadId.make("work-0"), { status: "running", activityRunStatus: "running" }),
      shell(ThreadId.make("queue-0"), { status: "idle", queuedMessageCount: 1 }),
      shell(child, {
        lineage: {
          rootThreadId: owner,
          parentThreadId: ThreadId.make("question-0"),
          relationshipToParent: "subagent",
        },
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("latest-question"),
          kind: "user_input",
          createdAt: later,
        },
      }),
    );
    const groups = deriveThreadSwarmGroups({
      ownerThreadId: owner,
      swarms: [...history, ...current],
      tasks: [],
      threads: threads.toReversed(),
    });
    expect(groups.slice(0, 6).map((row) => row.swarm.id)).toEqual([
      "question",
      "queue",
      "work",
      "held",
      "idle",
      "idle-older",
    ]);
    expect(groups.slice(6, 18).map((row) => row.swarm.id)).toEqual([
      "history-9",
      "history-8",
      "history-7",
      "history-6",
      "history-5",
      "history-4",
      "history-3",
      "history-2",
      "history-1",
      "history-0",
    ]);
    expect(groups.find((row) => row.swarm.id === "held")?.members[0]).toMatchObject({
      working: false,
      queuedCount: 2,
      heldCount: 2,
      canStop: true,
    });
    expect(groups[0]?.members[0]?.inputThreads.map((row) => row.id)).toEqual([
      "question-descendant",
    ]);
  });

  it("breaks creation-time ties by stable ID independently of storage order", () => {
    const tied = ["zeta", "beta", "alpha"].map((id) => swarm({ id: SwarmId.make(id) }));
    const input = { ownerThreadId: owner, tasks: [], threads: [shell(a), shell(b)] };
    expect(deriveThreadSwarmGroups({ ...input, swarms: tied }).map((row) => row.swarm.id)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
    expect(
      deriveThreadSwarmGroups({ ...input, swarms: tied.toReversed() }).map((row) => row.swarm.id),
    ).toEqual(["alpha", "beta", "zeta"]);
  });
});

describe("swarm projection compatibility", () => {
  it("preserves immutable identity, closed lifecycle and revoked admission across stale replacement", () => {
    const closed = swarm({
      lifecycle: { state: "closed", closedAt: later },
      members: swarm().members.map((member) => ({
        ...member,
        admission: { state: "revoked", revokedAt: later },
      })),
    });
    const incoming = swarm({
      ownerThreadId: ThreadId.make("wrong-owner"),
      title: "Wrong",
      members: swarm().members.toReversed(),
    });
    const next = applyOrchestrationV2ProjectionEvent(
      { ...v2Projection, swarms: [closed] },
      {
        id: EventId.make("stale"),
        threadId: owner,
        type: "swarm.updated",
        occurredAt: later,
        payload: incoming,
      },
    );
    expect(
      next?.swarms?.map((group) => ({
        owner: group.ownerThreadId,
        title: group.title,
        lifecycle: group.lifecycle.state,
        members: group.members.map((member) => [member.threadId, member.admission.state]),
      })),
    ).toEqual([
      {
        owner: owner,
        title: "Review",
        lifecycle: "closed",
        members: [
          ["member-a", "revoked"],
          ["member-b", "revoked"],
        ],
      },
    ]);
  });

  it("decodes historical snapshots with empty groups and handles newer unknown events without removing existing groups", () => {
    expect(decodeProjection(v2Projection).swarms).toEqual([]);
    expect(decodeShell(v2ThreadShell).queuedMessageCount).toBe(0);
    const items = decodeStreamItems([
      {
        kind: "event",
        sequence: 1,
        event: {
          id: "future",
          threadId: owner,
          type: "swarm.future-event",
          occurredAt: DateTime.formatIso(later),
          payload: { swarmId: "swarm-review" },
        },
      },
      {
        kind: "event",
        sequence: 2,
        event: {
          id: "detach",
          threadId: owner,
          type: "provider-session.detached",
          occurredAt: DateTime.formatIso(later),
          payload: { providerSessionId: "session", detachedAt: DateTime.formatIso(later) },
        },
      },
    ]);
    let projection: OrchestrationV2ThreadProjection | null = { ...v2Projection, swarms: [swarm()] };
    for (const item of items)
      if (item.kind === "event")
        projection = applyOrchestrationV2ProjectionEvent(projection, item.event);
    expect(items.map((item) => item.kind)).toEqual(["unknown-event", "event"]);
    expect(projection?.swarms?.map((group) => group.title)).toEqual(["Review"]);
    const downgraded = decodeProjection(v2Projection);
    expect(
      deriveThreadSwarmGroups({
        ownerThreadId: owner,
        swarms: downgraded.swarms ?? [],
        tasks: [],
        threads: [],
      }),
    ).toEqual([]);
  });
});
