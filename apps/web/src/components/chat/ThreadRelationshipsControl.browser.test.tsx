import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ projection: null as unknown }));

vi.mock(import("../../state/entities"), () => ({
  useProjects: () => [],
  useQuietThreadShell: () => null,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
  useThreadRelationshipShells: () => [],
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: () => null,
  useEnvironmentProviders: () => new Map(),
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () => undefined) as never,
}));
vi.mock(import("../../state/threads"), () => ({
  threadEnvironment: {} as never,
}));
vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: {
    stopWorkflow: { permissionAtom: () => Atom.make(false) },
  } as never,
}));

import "~/index.css";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

it("opens an idle child from Lineage when its shell has not been loaded", async () => {
  const projection = makeThreadProjectionFixture();
  const childId = ThreadId.make("omitted-child");
  const environmentId = EnvironmentId.make("local");
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("agent"),
        threadId: projection.thread.id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Inspect the change",
        title: "Idle child",
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: projection.thread.updatedAt,
        updatedAt: projection.thread.updatedAt,
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={projection.thread.id} />,
  );
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const child = screen.getByRole("button", { name: /Idle child/ });
  await expect.element(child).toBeEnabled();
  await child.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/local/omitted-child"),
  );
});
