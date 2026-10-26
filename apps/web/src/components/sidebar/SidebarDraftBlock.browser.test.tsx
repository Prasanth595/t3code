import { EnvironmentId, ProjectId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ terminals: [] as TerminalSummary[] }));

vi.mock(import("~/state/terminalSessions"), async (original) => ({
  ...(await original()),
  useTerminalLabelsByThreadKey: (environmentIds) =>
    new Map(
      environmentIds.flatMap((environmentId) =>
        state.terminals.map((terminal) => [
          `${environmentId}:${terminal.threadId}`,
          terminal.label,
        ]),
      ),
    ),
}));

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore, type DraftSessionState } from "../../composerDraftStore";
import { SidebarDraftBlock } from "./SidebarDraftBlock";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");

function draftSession(threadId: string, createdAt: string): DraftSessionState {
  return {
    threadId: ThreadId.make(threadId),
    environmentId,
    projectId,
    logicalProjectKey: `${environmentId}:${projectId}`,
    createdAt,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  };
}

function terminal(threadId: string, running: boolean): TerminalSummary {
  return {
    threadId,
    terminalId: "default",
    cwd: "/repo",
    worktreePath: null,
    status: running ? "running" : "exited",
    pid: running ? 123 : null,
    exitCode: running ? null : 0,
    exitSignal: null,
    hasRunningSubprocess: running,
    label: "dev",
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
}

function block(routeDraftId: string | null) {
  return (
    <SidebarDraftBlock
      projectByKey={new Map()}
      projectDisplayNameByKey={new Map()}
      scopedProjectKeys={null}
      routeDraftId={routeDraftId}
      onNavigateToDraft={() => {}}
      onDraftContextMenu={() => {}}
    />
  );
}

it("lists empty drafts while their script terminal exists, even after it exits", async () => {
  const running = DraftId.make("draft-running");
  const exited = DraftId.make("draft-exited");
  const idle = DraftId.make("draft-idle");
  state.terminals = [terminal("thread-running", true), terminal("thread-exited", false)];
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {
      [running]: draftSession("thread-running", "2026-10-25T00:00:03.000Z"),
      [exited]: draftSession("thread-exited", "2026-10-25T00:00:02.000Z"),
      [idle]: draftSession("thread-idle", "2026-10-25T00:00:01.000Z"),
    },
  });
  using _drafts = {
    [Symbol.dispose]: () =>
      useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} }),
  };

  await using screen = await render(block(running));
  const rows = () => document.querySelectorAll('[data-testid="sidebar-draft-row"]');
  expect(rows()).toHaveLength(2);
  expect(rows()[0]?.textContent).toContain("dev");

  await screen.rerender(block(null));
  expect(rows()).toHaveLength(2);
});
