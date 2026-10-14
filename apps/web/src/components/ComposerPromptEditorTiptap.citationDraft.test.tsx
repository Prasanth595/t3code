// @vitest-environment jsdom

import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { act, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./chat/AssistantCitationSource", () => ({
  observePendingAssistantCitationSource: () => () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
// Keep the real chip and comment editor while replacing floating layers. The trigger
// opens the popover the way a press would.
vi.mock("./ui/popover", async () => {
  const { createContext, use } = await import("react");
  type OnOpenChange = (open: boolean, details: { reason: string; cancel: () => void }) => void;
  const OpenContext = createContext<OnOpenChange>(() => {});
  return {
    Popover: ({ children, onOpenChange }: { children: ReactNode; onOpenChange: OnOpenChange }) => (
      <OpenContext value={onOpenChange}>{children}</OpenContext>
    ),
    PopoverTrigger: function PopoverTrigger({ "aria-label": label }: { "aria-label": string }) {
      const onOpenChange = use(OpenContext);
      return (
        <button
          aria-label={label}
          onClick={() => onOpenChange(true, { reason: "trigger-press", cancel: () => {} })}
        />
      );
    },
    PopoverPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
    PopoverClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const promptBefore = `See ${serializeAssistantCitation(citation)} `;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Mirrors ChatComposer: a pending question shows its answer in the same editor.
function Composer({
  question,
  editorRef,
  initialPrompt = promptBefore,
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [answer, setAnswer] = useState("");
  return (
    <>
      <output data-prompt={prompt} data-answer={answer} />
      <ComposerPromptEditor
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(next) => (question ? setAnswer(next) : setPrompt(next))}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
        }}
        onPaste={() => {}}
      />
    </>
  );
}

/** Types an unsaved comment on the inline chip, then lets a question take the editor and leave. */
async function commentThenAsk(initialPrompt: string) {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const render = (question: boolean) =>
    act(async () =>
      root.render(
        <Composer question={question} editorRef={editorRef} initialPrompt={initialPrompt} />,
      ),
    );
  await render(false);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Add comment to citation"]')?.click(),
  );
  const textarea = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Comment on selected text"]',
  );
  if (!textarea) throw new Error("Comment editor did not open");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(textarea, "check this");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render(true);
  expect(container.querySelector("output")?.dataset.answer).toBe("");
  await render(false);
  return container.querySelector("output")?.dataset.prompt;
}

const commented = `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `;

it("keeps an unsaved citation comment when a question takes the composer", async () => {
  expect(await commentThenAsk(promptBefore)).toBe(commented);
  expect(container.querySelector('[aria-label="Edit citation comment"]')).not.toBeNull();
});

it("keeps the quote cards above a chip whose unsaved comment is saved", async () => {
  const card = serializeAssistantCitation({ ...citation, text: "card", start: 10, end: 14 });
  expect(await commentThenAsk(`${card}\n\n${promptBefore}`)).toBe(`${card}\n\n${commented}`);
});
