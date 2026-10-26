import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { SidebarDraftBlock } from "./SidebarDraftBlock";

const environmentId = EnvironmentId.make("environment-local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const draftId = DraftId.make("draft-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

describe("SidebarDraftBlock", () => {
  it("lists an unsent draft whose only content is an open terminal", async () => {
    using _stores = {
      [Symbol.dispose]: () => {
        useComposerDraftStore.setState({
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {},
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        });
        useTerminalUiStateStore.setState({
          terminalUiStateByThreadKey: {},
          suppressedTerminalIdsByThreadKey: {},
        });
      },
    };
    useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
      threadId: threadRef.threadId,
    });
    useTerminalUiStateStore.getState().newTerminal(threadRef, "terminal-1");

    await using screen = await render(
      <SidebarDraftBlock
        projectByKey={new Map()}
        projectDisplayNameByKey={new Map()}
        scopedProjectKeys={null}
        routeDraftId={null}
        onNavigateToDraft={vi.fn()}
        onDraftContextMenu={vi.fn()}
      />,
    );

    await expect.element(screen.getByRole("button", { name: /Terminal open/ })).toBeVisible();
  });
});
