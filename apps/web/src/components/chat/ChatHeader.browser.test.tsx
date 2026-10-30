import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";
import { openThreadRename } from "./threadRenameBus";

const mocks = vi.hoisted(() => ({ canOperate: true, updateMetadata: vi.fn() }));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => mocks.canOperate,
  readEnvironmentScope: () => mocks.canOperate,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.updateMetadata,
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => "Inter" }));
vi.mock("./guestShareAvailability", async () => {
  const { Atom } = await import("effect/reactivity");
  const available = Atom.make(false);
  return { canShareWithGuestAtom: () => available };
});
vi.mock("./GuestShareControls", () => ({ GuestShareIndicator: () => null }));

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));

function setup() {
  mocks.canOperate = true;
  mocks.updateMetadata.mockReset().mockResolvedValue({ _tag: "Success" });
}

function Header(props: { environmentId?: EnvironmentId; isServerThread?: boolean }) {
  return (
    <>
      <textarea aria-label="Composer" />
      <ChatHeader
        activeThreadEnvironmentId={props.environmentId ?? threadRef.environmentId}
        activeThreadId={threadRef.threadId}
        activeThreadTitle="Original title"
        isServerThread={props.isServerThread ?? true}
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
    </>
  );
}

it("selects the title, preserves an in-progress edit, saves once and restores composer focus", async () => {
  setup();
  await using screen = await render(<Header />);
  const composer = screen.getByRole("textbox", { name: "Composer" });
  await composer.click();
  await act(() => openThreadRename(threadRef));
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await expect.element(input).toHaveFocus();
  const element = input.element() as HTMLInputElement;
  expect([element.selectionStart, element.selectionEnd]).toEqual([0, "Original title".length]);

  await userEvent.keyboard("  Updated title  ");
  await act(() => openThreadRename(threadRef));
  await expect.element(input).toHaveValue("  Updated title  ");
  await userEvent.keyboard("{Enter}");

  await expect.element(input).not.toBeInTheDocument();
  expect(mocks.updateMetadata).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, title: "Updated title" },
  });
  await expect.element(composer).toHaveFocus();
});

it("cancels with Escape without saving on blur and restores focus", async () => {
  setup();
  await using screen = await render(<Header />);
  const composer = screen.getByRole("textbox", { name: "Composer" });
  await composer.click();
  await act(() => openThreadRename(threadRef));
  await userEvent.keyboard("Discard this{Escape}");

  await expect
    .element(screen.getByRole("textbox", { name: "Thread title" }))
    .not.toBeInTheDocument();
  expect(mocks.updateMetadata).not.toHaveBeenCalled();
  await expect.element(composer).toHaveFocus();
});

it("ignores another environment, drafts and read-only access, including access revoked before saving", async () => {
  setup();
  await using screen = await render(<Header environmentId={EnvironmentId.make("remote")} />);
  await act(() => openThreadRename(threadRef));
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await expect.element(input).not.toBeInTheDocument();

  await screen.rerender(<Header isServerThread={false} />);
  await act(() => openThreadRename(threadRef));
  await expect.element(input).not.toBeInTheDocument();

  mocks.canOperate = false;
  await screen.rerender(<Header />);
  await act(() => openThreadRename(threadRef));
  await expect.element(input).not.toBeInTheDocument();

  mocks.canOperate = true;
  await screen.rerender(<Header />);
  await act(() => openThreadRename(threadRef));
  await expect.element(input).toHaveFocus();
  await userEvent.keyboard("Unsaved");
  mocks.canOperate = false;
  await userEvent.keyboard("{Enter}");
  await expect.element(input).not.toBeInTheDocument();
  expect(mocks.updateMetadata).not.toHaveBeenCalled();
});
