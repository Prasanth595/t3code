import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  updateTitle: (_title: string) => {},
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => async ({ input }: { input: { title: string } }) => {
    state.updateTitle(input.title);
    return { _tag: "Success" };
  }) as never,
}));
vi.mock(import("../../hooks/useSettings"), () => ({
  useClientSettings: (() => "Inter") as never,
}));
vi.mock(import("../../hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));

import { act, render } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

function ThreadHeader() {
  const [title, setTitle] = useState("New thread");
  state.updateTitle = setTitle;
  return (
    <ChatHeader
      activeThreadEnvironmentId={EnvironmentId.make("local")}
      activeThreadId={ThreadId.make("thread")}
      activeThreadTitle={title}
      isServerThread
      activeProject={null}
      parentThreadLink={null}
      onOpenThread={() => {}}
      rightPanelOpen={false}
      onNewThreadInProject={() => {}}
    />
  );
}

it.each(["blur", "Enter"])(
  "preserves an external title update when an untouched rename ends with %s",
  async (commit) => {
    state.updateTitle = () => {};
    await using screen = await render(<ThreadHeader />);
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");
    await act(() => state.updateTitle("Fix login redirect"));
    if (commit === "Enter") {
      await userEvent.keyboard("{Enter}");
    } else {
      await act(() => (input.element() as HTMLInputElement).blur());
    }
    await expect
      .element(screen.getByRole("button", { name: "Thread actions for Fix login redirect" }))
      .toBeVisible();
  },
);
