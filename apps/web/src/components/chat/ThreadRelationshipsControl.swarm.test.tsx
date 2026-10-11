import { cloneElement, type ReactElement, type ReactNode } from "react";
import { RegistryContext } from "@effect/atom-react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SwarmId,
  ThreadId,
  type AuthSessionState,
  type OrchestrationV2StopSwarmInput,
  type OrchestrationV2Swarm,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import type {
  EnvironmentRegistry as RegistryService,
  EnvironmentSupervisor as SupervisorService,
  ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type RefValue<Ref> = Ref extends import("effect/SubscriptionRef").SubscriptionRef<infer Value>
  ? Value
  : never;

const state = vi.hoisted(() => {
  const shells: OrchestrationV2ThreadShell[] = [];
  const writes: OrchestrationV2StopSwarmInput[] = [];
  const projection = (): typeof v2Projection | null => null;
  return {
    projection: projection(),
    shells,
    writes,
    ordinaryCommand: vi.fn().mockResolvedValue({ _tag: "Success" }),
    navigate: vi.fn(),
    nextId: 0,
  };
});

const environmentId = EnvironmentId.make("remote");
const v2Now = DateTime.makeUnsafe("2026-06-20T00:00:00Z");
const v2ThreadShell: OrchestrationV2ThreadShell = {
  id: ThreadId.make("thread-v2"),
  projectId: ProjectId.make("project"),
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    rootThreadId: ThreadId.make("thread-v2"),
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: v2Now,
  updatedAt: v2Now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const v2Projection: OrchestrationV2ThreadProjection = {
  thread: { ...v2ThreadShell, lastVisitedAt: null },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: v2Now,
};
const owner = v2Projection.thread.id;
const a = ThreadId.make("member-a");
const b = ThreadId.make("member-b");
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const supported = Atom.make(true);
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;

vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: state.projection }),
  useThreadShells: () => state.shells.map((source) => ({ environmentId, source })),
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    interruptTurn: { label: "interrupt" },
    mergeBack: { label: "merge" },
    stopSession: { label: "session" },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { nativeSwarmsSupportedAtom: () => supported },
}));
vi.mock("../../state/orchestration", async () => {
  const { createEnvironmentRpcCommand } = await import("@t3tools/client-runtime/state/runtime");
  const {
    EnvironmentRegistry,
    EnvironmentSupervisor,
    PrimaryConnectionTarget,
    AVAILABLE_CONNECTION_STATE,
  } = await import("@t3tools/client-runtime/connection");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const Option = await import("effect/Option");
  const { Atom } = await import("effect/reactivity");
  const { ORCHESTRATION_V2_WS_METHODS } = await import("@t3tools/contracts");
  const runtime = Atom.runtime(
    Layer.unwrap(
      Effect.gen(function* () {
        const supervisor = Layer.mock(EnvironmentSupervisor.EnvironmentSupervisor, {
          target: new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make("remote"),
            label: "Remote",
            httpBaseUrl: "https://remote.test",
            wsBaseUrl: "wss://remote.test/ws",
          }),
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make<
            RefValue<SupervisorService.EnvironmentSupervisor["Service"]["session"]>
          >(Option.none()),
          prepared: yield* SubscriptionRef.make<
            RefValue<SupervisorService.EnvironmentSupervisor["Service"]["prepared"]>
          >(Option.none()),
        });
        return Layer.mock(EnvironmentRegistry.EnvironmentRegistry, {
          entries: yield* SubscriptionRef.make<
            RefValue<RegistryService.EnvironmentRegistry["Service"]["entries"]>
          >(new Map<EnvironmentId, ConnectionCatalogEntry>()),
          networkStatus:
            yield* SubscriptionRef.make<
              RefValue<RegistryService.EnvironmentRegistry["Service"]["networkStatus"]>
            >("online"),
          run: (_id, effect) => effect.pipe(Effect.provide(supervisor)),
        });
      }),
    ),
  );
  const makeStop = () =>
    createEnvironmentRpcCommand(runtime, {
      label: "stop-swarm",
      tag: ORCHESTRATION_V2_WS_METHODS.stopSwarm,
      execute: (input) =>
        Effect.sync(() => {
          state.writes.push(input);
        }),
    });
  let stop: ReturnType<typeof makeStop> | undefined;
  return {
    orchestrationEnvironment: {
      stopWorkflow: { label: "workflow", permissionAtom: () => Atom.make(false) },
      get stopSwarm() {
        return (stop ??= makeStop());
      },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "stop-swarm"
      ? (input: Parameters<typeof orchestrationEnvironment.stopSwarm.run>[1]) =>
          orchestrationEnvironment.stopSwarm.run(registry, input)
      : state.ordinaryCommand,
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => `stop-${++state.nextId}`,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../ThreadHoverCard", () => ({ ThreadHoverCardPopup: () => null }));
vi.mock("./ThreadDetailsControl", () => ({
  ThreadDetailsControl: "button",
}));
vi.mock("./ThreadDetailsSection", () => ({
  ThreadDetailsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

import { orchestrationEnvironment } from "../../state/orchestration";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const group: OrchestrationV2Swarm = {
  id: SwarmId.make("swarm"),
  ownerThreadId: owner,
  ownerRunId: RunId.make("owner-run"),
  creationCommandId: CommandId.make("create"),
  title: "Review",
  lifecycle: { state: "open" },
  createdAt: v2Now,
  updatedAt: v2Now,
  members: [a, b].map((threadId) => ({
    threadId,
    taskId: NodeId.make(`task-${threadId}`),
    title: threadId,
    admission: { state: "admitted" },
  })),
};
const shell = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id,
  title: id,
  lineage: { rootThreadId: owner, parentThreadId: owner, relationshipToParent: "subagent" },
  ...overrides,
});
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  registry.set(sessions(environmentId), AsyncResult.success(grant(true)));
  registry.set(supported, true);
  state.projection = { ...v2Projection, swarms: [group] };
  state.shells = [shell(a), shell(b)];
  state.writes = [];
  state.nextId = 0;
  state.ordinaryCommand.mockClear();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <ThreadRelationshipsPanel environmentId={environmentId} threadId={owner} />
      </RegistryContext.Provider>,
    );
  });
  const expand = renderer?.root.findAll(
    (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("Expand Swarm"),
  )[0];
  if (!expand) throw new Error("Swarm disclosure missing");
  await act(() => expand.props.onClick());
};
const memberStop = () => {
  const button = renderer?.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Stop subagent member-a",
  )[0];
  if (!button) throw new Error("Member Stop missing");
  return button;
};

it.each(["held queue", "descendant"])(
  "dispatches guarded member Stop for %s without its own active run",
  async (work) => {
    state.shells =
      work === "held queue"
        ? [
            shell(a, { status: "queued", queuedMessageCount: 1, heldQueuedMessageCount: 1 }),
            shell(b),
          ]
        : [
            shell(a),
            shell(b),
            shell(ThreadId.make("descendant"), {
              status: "running",
              activityRunStatus: "running",
              lineage: { rootThreadId: owner, parentThreadId: a, relationshipToParent: "subagent" },
            }),
          ];
    await mount();
    await act(async () => {
      await memberStop().props.onClick();
    });
    expect(state.writes).toEqual([
      { threadId: "thread-v2", swarmId: "swarm", memberThreadId: "member-a", commandId: "stop-1" },
    ]);
    expect(state.ordinaryCommand.mock.calls).toEqual([]);
  },
);

it("stops later ordinary work on a closed member with a fresh command each time", async () => {
  state.projection = {
    ...v2Projection,
    swarms: [
      {
        ...group,
        lifecycle: { state: "closed", closedAt: v2Now },
        members: group.members.map((member) => ({
          ...member,
          admission: { state: "revoked", revokedAt: v2Now },
        })),
      },
    ],
  };
  state.shells = [shell(a, { status: "running", activityRunStatus: "running" }), shell(b)];
  await mount();
  await act(async () => {
    await memberStop().props.onClick();
  });
  await act(async () => {
    await memberStop().props.onClick();
  });
  expect(state.writes).toEqual([
    { threadId: "thread-v2", swarmId: "swarm", memberThreadId: "member-a", commandId: "stop-1" },
    { threadId: "thread-v2", swarmId: "swarm", memberThreadId: "member-a", commandId: "stop-2" },
  ]);
  expect(state.projection.swarms?.[0]?.lifecycle.state).toBe("closed");
});

it("rechecks the operate grant when a displayed member control is invoked", async () => {
  state.shells = [shell(a, { queuedMessageCount: 1, heldQueuedMessageCount: 1 }), shell(b)];
  await mount();
  const click = memberStop().props.onClick;
  await act(() => {
    registry.set(sessions(environmentId), AsyncResult.success(grant(false)));
  });
  await act(async () => {
    await click();
  });
  expect(state.writes).toEqual([]);
  expect(state.ordinaryCommand.mock.calls).toEqual([]);
  expect(
    renderer?.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Stop subagent member-a",
    ),
  ).toHaveLength(0);
});

it("hides group and member Stop on an unsupported environment", async () => {
  state.shells = [shell(a, { queuedMessageCount: 1, heldQueuedMessageCount: 1 }), shell(b)];
  registry.set(supported, false);
  await mount();
  expect(
    renderer?.root.findAll(
      (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("Stop "),
    ),
  ).toHaveLength(0);
  expect(state.writes).toEqual([]);
});

it("keeps whole-group Stop on the same guarded command without a member selector", async () => {
  await mount();
  const stop = renderer?.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Stop swarm Review",
  )[0];
  if (!stop) throw new Error("Group Stop missing");
  await act(async () => {
    await stop.props.onClick();
  });
  expect(state.writes).toEqual([{ threadId: "thread-v2", swarmId: "swarm", commandId: "stop-1" }]);
});

it("keeps ordinary subagent interruption on its existing operation", async () => {
  const ordinary = ThreadId.make("ordinary");
  state.projection = {
    ...v2Projection,
    swarms: [group],
    subagents: [
      {
        id: NodeId.make("ordinary-task"),
        threadId: owner,
        runId: RunId.make("owner-run"),
        parentNodeId: NodeId.make("owner-node"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        childThreadId: ordinary,
        nativeTaskRef: null,
        prompt: "Ordinary work",
        title: "Ordinary",
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
      },
    ],
  };
  state.shells = [
    shell(a),
    shell(b),
    shell(ordinary, {
      status: "running",
      activityRunStatus: "running",
      activityRunStartedAt: v2Now,
    }),
  ];
  await mount();
  const stop = renderer?.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Stop subagent ordinary",
  )[0];
  if (!stop) throw new Error("Ordinary Stop missing");
  await act(async () => {
    await stop.props.onClick();
  });
  expect(state.ordinaryCommand.mock.calls).toEqual([
    [{ environmentId: "remote", input: { threadId: "ordinary" } }],
  ]);
  expect(state.writes).toEqual([]);
});

it("pages historical groups after current descendant work and held queue attention", async () => {
  const history = Array.from({ length: 10 }, (_, index): OrchestrationV2Swarm => ({
    ...group,
    id: SwarmId.make(`history-${index}`),
    title: `History ${index}`,
    lifecycle: { state: "closed", closedAt: v2Now },
    members: group.members.map((member, memberIndex) => ({
      ...member,
      threadId: ThreadId.make(`history-${index}-${memberIndex}`),
    })),
  }));
  const held: OrchestrationV2Swarm = {
    ...group,
    id: SwarmId.make("held"),
    title: "Held",
    members: group.members.map((member, index) => ({
      ...member,
      threadId: ThreadId.make(`held-${index}`),
    })),
  };
  state.projection = { ...v2Projection, swarms: [...history, held, group] };
  state.shells = [
    shell(a),
    shell(b),
    shell(ThreadId.make("held-0"), { queuedMessageCount: 1, heldQueuedMessageCount: 1 }),
    shell(ThreadId.make("descendant"), {
      status: "running",
      activityRunStatus: "running",
      lineage: { rootThreadId: owner, parentThreadId: a, relationshipToParent: "subagent" },
    }),
  ];
  await mount();
  const disclosures = () =>
    renderer?.root
      .findAll(
        (node) => node.type === "button" && String(node.props["aria-label"]).includes("Swarm ·"),
      )
      .map((node) => node.props["aria-label"]);
  expect(disclosures()).toEqual([
    "Collapse Swarm · Review, 2 members, 1 working",
    "Expand Swarm · Held, 2 members, 1 queued, 1 held",
    "Expand Swarm · History 0, 2 members, Closed",
    "Expand Swarm · History 1, 2 members, Closed",
    "Expand Swarm · History 2, 2 members, Closed",
    "Expand Swarm · History 3, 2 members, Closed",
  ]);
  const more = renderer?.root.findAll(
    (node) => node.type === "button" && node.children.includes(" more"),
  )[0];
  if (!more) throw new Error("Historical pagination missing");
  await act(() => more.props.onClick());
  expect(disclosures()).toEqual([
    "Collapse Swarm · Review, 2 members, 1 working",
    "Expand Swarm · Held, 2 members, 1 queued, 1 held",
    "Expand Swarm · History 0, 2 members, Closed",
    "Expand Swarm · History 1, 2 members, Closed",
    "Expand Swarm · History 2, 2 members, Closed",
    "Expand Swarm · History 3, 2 members, Closed",
    "Expand Swarm · History 4, 2 members, Closed",
    "Expand Swarm · History 5, 2 members, Closed",
    "Expand Swarm · History 6, 2 members, Closed",
    "Expand Swarm · History 7, 2 members, Closed",
    "Expand Swarm · History 8, 2 members, Closed",
    "Expand Swarm · History 9, 2 members, Closed",
  ]);
});
