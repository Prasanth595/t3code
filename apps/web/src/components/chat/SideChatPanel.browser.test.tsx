import * as Cause from "effect/Cause";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import { SideChat } from "./SideChatPanel";

const state = vi.hoisted(() => ({
  branch: vi.fn(),
  remove: vi.fn(),
  threads: [] as { id: string; latestUserMessageAt?: string | null }[],
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ threads: state.threads }),
}));
vi.mock("../../state/shell", () => ({
  environmentSnapshotAtom: () => null,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { createSideChat: "branch", delete: "remove" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (name: "branch" | "remove") => state[name],
}));
vi.mock("./SideChat", () => ({
  SideChatSession: ({ prompt }: { prompt: string }) => {
    const [text, setText] = useState(prompt);
    return <textarea value={text} onChange={(event) => setText(event.target.value)} />;
  },
}));

let renderer: Root;
let container: HTMLDivElement;
const textareas = () => [...container.querySelectorAll("textarea")];
const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const alerts = () => container.querySelectorAll('[role="alert"]');
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const setDraft = (value: string) => userEvent.fill(page.getByRole("textbox"), value);

const close = vi.fn();
const props = {
  source: { id: "source", environmentId: "env" },
  cwd: undefined,
  request: { serial: 1, prompt: "one" },
  onClose: close,
  settings: {},
  instanceEntries: [],
} as unknown as ComponentProps<typeof SideChat>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.branch.mockReset().mockResolvedValue({ _tag: "Success" });
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
  close.mockReset();
  state.threads = [{ id: "source", latestUserMessageAt: null }];
  await act(async () => {
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    renderer.render(<SideChat {...props} />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens distinct snapshots and preserves drafts when switching tabs", async () => {
  await setDraft("unsent one");
  await act(async () =>
    renderer.render(<SideChat {...props} request={{ serial: 2, prompt: "two" }} />),
  );
  expect(state.branch).toHaveBeenCalledTimes(2);
  expect(state.branch.mock.calls[0]![0].input.targetThreadId).not.toBe(
    state.branch.mock.calls[1]![0].input.targetThreadId,
  );
  expect(textareas().map((item) => item.value)).toEqual(["unsent one", "two"]);
  await act(async () => tabs()[0]!.click());
  expect(
    [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].map((item) => item.hidden),
  ).toEqual([false, true]);
});

it("does not lose a newly opened tab when an earlier close finishes", async () => {
  let finish!: (value: { _tag: string }) => void;
  state.remove.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button("Close side chat 1").click());
  await act(async () => button("New side chat").click());
  await act(async () => finish({ _tag: "Success" }));
  expect(tabs()).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
});

it("hiding and revisiting a side panel preserves its tab and draft without creating a snapshot", async () => {
  await setDraft("keep my draft");
  await act(async () => renderer.render(<SideChat {...props} visible={false} />));
  await act(async () => renderer.render(<SideChat {...props} visible />));
  expect(state.branch).toHaveBeenCalledTimes(1);
  expect(tabs()).toHaveLength(1);
  expect(textareas()[0]!.value).toBe("keep my draft");
});

it("a failed close retains both independent drafts and allows a successful retry", async () => {
  await setDraft("first draft");
  await act(async () =>
    renderer.render(<SideChat {...props} request={{ serial: 2, prompt: "second draft" }} />),
  );
  state.threads.push(
    ...state.branch.mock.calls.map(([request]) => ({ id: request.input.targetThreadId })),
  );
  state.remove.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Disconnected")),
  });
  await act(async () => button("Close side chat 1").click());
  expect(textareas().map((item) => item.value)).toEqual(["first draft", "second draft"]);
  expect(close).not.toHaveBeenCalled();
  await act(async () => button("Close side chat 1").click());
  expect(textareas()[0]!.value).toBe("second draft");
  expect(state.remove.mock.calls[0]![0]).toEqual(state.remove.mock.calls[1]![0]);
  expect(state.branch).toHaveBeenCalledTimes(2);
});

it("offers to close older snapshots only after a new main user message", async () => {
  const withMessage = (id: string, role: "user" | "assistant", createdAt: string) => {
    if (role === "user")
      state.threads = state.threads.map((thread) =>
        thread.id === "source" ? { ...thread, latestUserMessageAt: createdAt } : thread,
      );
    return {
      ...props,
      source: { ...props.source, messages: [{ id, role, createdAt }] },
    } as unknown as ComponentProps<typeof SideChat>;
  };
  await act(async () =>
    renderer.render(<SideChat {...withMessage("a", "assistant", "2026-09-11T10:00:00Z")} />),
  );
  expect(alerts()).toHaveLength(0);
  await act(async () =>
    renderer.render(<SideChat {...withMessage("u", "user", "2026-09-11T10:01:00Z")} />),
  );
  expect(alerts()).toHaveLength(1);
  const olderId = state.branch.mock.calls[0]![0].input.targetThreadId;
  await act(async () => button("New side chat").click());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close older chats")!
      .click(),
  );
  expect(state.remove).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: olderId },
  });
  expect(tabs()).toHaveLength(1);
  expect(alerts()).toHaveLength(0);
});

it("loading old message pages does not prompt to close side chats", async () => {
  await act(async () =>
    renderer.render(
      <SideChat
        {...props}
        source={
          {
            ...props.source,
            messages: [{ role: "user", id: "old", createdAt: "2026-09-10T10:00:00Z" }],
          } as unknown as typeof props.source
        }
      />,
    ),
  );
  expect(alerts()).toHaveLength(0);
  expect(state.remove).not.toHaveBeenCalled();
});

it("opens an empty surface without creating a chat, then creates only on request", async () => {
  await act(async () => renderer.unmount());
  state.branch.mockClear();
  await act(async () => {
    renderer = createRoot(container);
    renderer.render(<SideChat {...props} request={null} />);
  });
  expect(state.branch).not.toHaveBeenCalled();
  await act(async () => renderer.render(<SideChat {...props} request={null} visible={false} />));
  await act(async () => renderer.render(<SideChat {...props} request={null} visible />));
  expect(state.branch).not.toHaveBeenCalled();
  await act(async () => button("New side chat").click());
  expect(state.branch).toHaveBeenCalledTimes(1);
});
