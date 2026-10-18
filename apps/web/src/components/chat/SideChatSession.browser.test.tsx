import type { OrchestrationV2ProjectedTurnItem, UserInputQuestion } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SideChatSession } from "./SideChat";

const state = vi.hoisted(() => ({
  start: vi.fn(),
  interrupt: vi.fn(),
  answer: vi.fn(),
  userInputs: [] as { requestId: string; questions: UserInputQuestion[] }[],
  status: "running",
  visibleTurnItems: [] as OrchestrationV2ProjectedTurnItem[],
  ctrlKey: false,
  metaKey: false,
  selection: {
    instanceId: "codex",
    model: "parent-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({}),
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadProjection: () => ({
    projection: {
      thread: {
        id: "side",
        modelSelection: state.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      messages: [{ id: "answer", role: "assistant", text: "Side answer", streaming: false }],
      turnItems: [],
      visibleTurnItems: state.visibleTurnItems,
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/thread-execution", () => ({
  deriveThreadRuntime: () => ({ status: state.status }),
}));
vi.mock("@t3tools/client-runtime/state/thread-requests", () => ({
  derivePendingThreadRequests: () => ({ approvals: [], userInputs: state.userInputs }),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    startTurn: "start",
    interruptTurn: "interrupt",
    respondToUserInput: "answer",
  },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (name: "start" | "interrupt" | "answer") => state[name],
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: () => ({}),
  getUploadedAttachments: () => [],
  startAttachmentUpload: vi.fn(),
  releaseAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
}));
vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: ({ model }: { model: string }) => <button type="button">{model}</button>,
}));
vi.mock("./TraitsPicker", () => ({
  TraitsPicker: () => null,
  TraitsMenuContent: () => null,
  getReasoningTraitStep: () => null,
  shouldRenderTraitsControls: () => false,
  buildUnavailableModelOptionDescriptors: () => [],
  buildTraitsTriggerDisplay: () => null,
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("./ChatComposer", () => ({
  ComposerFooterModeControls: () => null,
}));
vi.mock("../../shortcutModifierState", () => ({
  useShortcutModifierState: () => state,
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

vi.mock("./SecretRequestCard", () => ({
  SecretRequestCard: ({
    environmentId,
    visibility,
    item,
  }: {
    environmentId: string;
    visibility: string;
    item: { id: string; threadId: string; label: string };
  }) => (
    <div
      data-secret-request={item.id}
      data-environment={environmentId}
      data-visibility={visibility}
      data-thread={item.threadId}
    >
      {item.label}
    </div>
  ),
}));

let root: Root;
let container: HTMLDivElement;
const props = () =>
  ({
    source: {
      environmentId: "env",
      id: "parent",
      modelSelection: state.selection,
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    threadId: "side",
    prompt: "Change direction",
    active: true,
    settings: { planModeEnabled: false },
    instanceEntries: [],
  }) as unknown as ComponentProps<typeof SideChatSession>;
const render = () =>
  act(async () => {
    root.render(<SideChatSession {...props()} />);
  });
const draft = () => container.querySelector("textarea")!;
const send = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.status = "running";
  state.userInputs = [];
  state.answer.mockReset().mockResolvedValue({ _tag: "Success" });
  state.visibleTurnItems = [];
  state.ctrlKey = false;
  state.metaKey = false;
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("steers the side thread with the inherited model and clears only accepted input", async () => {
  expect(send().getAttribute("aria-label")).toBe("Steer message");
  await act(async () => send().click());
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: "env",
      input: expect.objectContaining({
        threadId: "side",
        dispatchMode: "steer",
        modelSelection: state.selection,
        message: expect.objectContaining({ text: "Change direction" }),
      }),
    }),
  );
  expect(draft().value).toBe("");
  expect(state.interrupt).not.toHaveBeenCalled();
});
it("keeps the failed steer draft for retry", async () => {
  state.start.mockRejectedValueOnce(new Error("Steering unavailable"));
  await act(async () => send().click());
  expect(draft().value).toBe("Change direction");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Steering unavailable");
  await act(async () => send().click());
  expect(draft().value).toBe("");
});
it("Enter steers and Shift+Enter keeps the multiline draft", async () => {
  await act(async () =>
    draft().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    ),
  );
  expect(state.start).not.toHaveBeenCalled();
  await act(async () =>
    draft().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(state.start.mock.calls[0]![0].input.dispatchMode).toBe("steer");
});
it.each(["ctrlKey", "metaKey"] as const)(
  "keeps %s-click steering with no queue action",
  async (modifier) => {
    state[modifier] = true;
    await render();
    expect(send().getAttribute("aria-label")).toBe("Steer message");
    expect(container.textContent).not.toContain("Queue");
    await act(async () =>
      send().dispatchEvent(new MouseEvent("click", { bubbles: true, [modifier]: true })),
    );
    expect(state.start.mock.calls[0]![0].input.dispatchMode).toBe("steer");
  },
);
it("submits normally when idle, retaining the server-resolved steering intent for races", async () => {
  state.status = "idle";
  await render();
  expect(send().getAttribute("aria-label")).toBe("Submit message");
  await act(async () => send().click());
  expect(state.start.mock.calls[0]![0].input.dispatchMode).toBe("steer");
});

it("shows the side answer without a separate send-to-main action", async () => {
  await render();
  expect(container.textContent).toContain("Side answer");
  expect(container.querySelector('[aria-label="Send to Main Chat"]')).toBeNull();
  expect(state.start).not.toHaveBeenCalled();
});

it.each(["local", "inherited"] as const)(
  "renders secret requests with their owning environment and %s visibility",
  async (visibility) => {
    const threadId = visibility === "local" ? "side" : "parent";
    state.visibleTurnItems = [
      {
        position: 0,
        visibility,
        sourceThreadId: threadId,
        sourceItemId: "secret-card",
        item: {
          id: "secret-card",
          threadId,
          type: "secret_request",
          label: "Deploy token",
          secretStatus: "pending",
        },
      },
    ] as unknown as OrchestrationV2ProjectedTurnItem[];
    await render();
    const card = container.querySelector('[data-secret-request="secret-card"]');
    expect(card?.textContent).toBe("Deploy token");
    expect(card?.getAttribute("data-environment")).toBe("env");
    expect(card?.getAttribute("data-visibility")).toBe(visibility);
    expect(card?.getAttribute("data-thread")).toBe(threadId);
  },
);

const editorRequest = () => [
  {
    requestId: "edit-request",
    questions: [
      {
        id: "proposal",
        header: "Proposed text",
        question: "Review this text",
        options: [],
        initialAnswer: "  First line\nSecond line\n",
      },
    ],
  },
];
it("shows and submits a proposed editor answer without changing its whitespace", async () => {
  state.userInputs = editorRequest();
  await render();
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Proposed text"]')!;
  expect(field.value).toBe("  First line\nSecond line\n");
  await userEvent.click(page.getByRole("button", { name: "Reply", exact: true }));
  expect(state.answer).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        threadId: "side",
        requestId: "edit-request",
        answers: { proposal: "  First line\nSecond line\n" },
      },
    }),
  );
});
it("preserves edits and an intentionally empty editor answer across projection refreshes", async () => {
  state.userInputs = editorRequest();
  await render();
  await userEvent.fill(
    page.getByRole("textbox", { name: "Proposed text", exact: true }),
    "Edited\ntext",
  );
  state.userInputs = editorRequest();
  await render();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Proposed text"]')!.value).toBe(
    "Edited\ntext",
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Proposed text", exact: true }), "");
  await render();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Proposed text"]')!.value).toBe(
    "",
  );
  await userEvent.click(page.getByRole("button", { name: "Reply", exact: true }));
  expect(state.answer).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ answers: { proposal: "" } }) }),
  );
});
