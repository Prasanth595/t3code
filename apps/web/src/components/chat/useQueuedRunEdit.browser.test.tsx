import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import {
  partializeComposerDraftStoreState,
  DraftId,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

const commands = vi.hoisted(() => ({
  save: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => commands.save) as never,
}));
vi.mock(import("../../assets/assetUrls"), () => ({ useAssetUrls: () => [] }));

function Editor({
  text = "Original message",
  queueState = null,
  threadIsLive = true,
}: {
  readonly text?: string;
  readonly queueState?: "queued" | "running" | "missing" | null;
  readonly threadIsLive?: boolean;
}) {
  const environmentId = EnvironmentId.make("environment:queue-edit");
  const threadId = ThreadId.make("thread:queue-edit");
  const threadRef = scopeThreadRef(environmentId, threadId);
  const promptRef = useRef("");
  const edit = useQueuedRunEdit({
    environmentId,
    routeThreadRef: threadRef,
    threadDraftTarget: threadRef,
    activeThreadId: threadId,
    threadIsLive,
    // This hook only reads run membership and message context from the projection.
    serverProjection:
      queueState === null
        ? null
        : ({
            runs:
              queueState === "missing"
                ? []
                : [{ id: RunId.make("run:queued"), status: queueState }],
            messages: [],
          } as unknown as NonNullable<Parameters<typeof useQueuedRunEdit>[0]["serverProjection"]>),
    promptRef,
    composerRef: { current: null },
  });
  const draft = useComposerThreadDraft(edit.draftTarget);
  return (
    <>
      <button
        onClick={() =>
          edit.beginEdit({
            runId: RunId.make("run:queued"),
            messageId: MessageId.make("message:queued"),
            text,
            attachments: [
              {
                type: "file",
                id: "file:report",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 6,
              },
            ],
          })
        }
      >
        Edit queued message
      </button>
      <textarea
        aria-label="Message"
        value={draft.prompt}
        onChange={(event) =>
          useComposerDraftStore.getState().setPrompt(edit.draftTarget, event.target.value)
        }
      />
      {edit.editingAttachments?.map(({ attachment }) => (
        <button key={attachment.id} onClick={() => edit.removeEditingAttachment(attachment.id)}>
          Remove {attachment.name}
        </button>
      ))}
      <button onClick={edit.cancelEdit}>Cancel edit</button>
      <button onClick={() => edit.saveEdit(draft, () => undefined)}>Save edit</button>
    </>
  );
}

function setup() {
  commands.save.mockClear();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
}

it.each(["Updated message", ""])(
  "restores the unsaved edit %j and attachment removals after leaving the thread",
  async (text) => {
    setup();
    // Navigation is simulated by rerendering, without route consumers.
    await using screen = await render(<Editor />, { router: false });
    await screen.getByRole("textbox", { name: "Message" }).fill("Separate draft");
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await screen.getByRole("textbox", { name: "Message" }).fill(text);
    await screen.getByRole("button", { name: "Remove report.pdf" }).click();
    await screen.rerender(<div>Another thread</div>);
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    useComposerDraftStore.setState(
      useComposerDraftStore.persist.getOptions().merge!(
        persisted,
        useComposerDraftStore.getInitialState(),
      ),
    );
    await screen.rerender(<Editor />);
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text);
    await expect
      .element(screen.getByRole("button", { name: "Remove report.pdf" }))
      .not.toBeInTheDocument();
    if (text) {
      await screen.getByRole("button", { name: "Save edit" }).click();
      await vi.waitFor(() =>
        expect(commands.save).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              text,
              edit: expect.objectContaining({ attachments: [] }),
            }),
          }),
        ),
      );
    } else {
      await screen.getByRole("button", { name: "Cancel edit" }).click();
    }
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Separate draft");
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Original message");
    await expect.element(screen.getByRole("button", { name: "Remove report.pdf" })).toBeVisible();
  },
);

it("saves an empty restored edit that keeps its attachment", async () => {
  setup();
  // Navigation is simulated by rerendering, without route consumers.
  await using screen = await render(<Editor />, { router: false });
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.getByRole("textbox", { name: "Message" }).fill("");
  await screen.rerender(<div>Another thread</div>);
  const persisted = JSON.parse(
    JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
  );
  useComposerDraftStore.setState(
    useComposerDraftStore.persist.getOptions().merge!(
      persisted,
      useComposerDraftStore.getInitialState(),
    ),
  );
  await screen.rerender(<Editor />);
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Remove report.pdf" })).toBeVisible();
  await screen.getByRole("button", { name: "Save edit" }).click();
  await vi.waitFor(() =>
    expect(commands.save).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          edit: expect.objectContaining({ attachments: [expect.anything()] }),
        }),
      }),
    ),
  );
});

it("reopens an untouched edit with the queued message saved by another client", async () => {
  setup();
  // Navigation is simulated by rerendering, without route consumers.
  await using screen = await render(<Editor />, { router: false });
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.rerender(<div>Another thread</div>);
  await screen.rerender(<Editor text="Updated message" />);
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Updated message");
});

it.each(["running", "missing"] as const)(
  "recovers a retained edit when its run became %s while the user was away",
  async (queueState) => {
    setup();
    // Navigation is simulated by rerendering, without route consumers.
    await using screen = await render(<Editor />, { router: false });
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await screen.getByRole("textbox", { name: "Message" }).fill("Keep this unsaved edit");
    await screen.rerender(<div>Another thread</div>);
    await screen.rerender(<Editor />);
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await screen.rerender(<Editor queueState={queueState} />);
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Keep this unsaved edit");
  },
);

it("keeps a separate composer draft and leaves other threads' retained edits alone", async () => {
  setup();
  const otherRef = scopeThreadRef(
    EnvironmentId.make("environment:queue-edit"),
    ThreadId.make("thread:other"),
  );
  const otherTarget = DraftId.make(`queued-edit:${scopedThreadKey(otherRef)}:run:other`);
  const store = useComposerDraftStore.getState();
  store.setPrompt(otherTarget, "Other thread edit");
  store.setQueuedMessageEdit(otherTarget, {
    messageId: MessageId.make("message:other"),
    originalText: "Original",
    removedAttachmentIds: [],
  });
  // Navigation is simulated by rerendering, without route consumers.
  await using screen = await render(<Editor />, { router: false });
  await screen.getByRole("textbox", { name: "Message" }).fill("Separate draft");
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.getByRole("textbox", { name: "Message" }).fill("Unsaved edit");
  await screen.rerender(<div>Another thread</div>);
  await screen.rerender(<Editor queueState="running" />);
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Separate draft");
  const editRef = scopeThreadRef(
    EnvironmentId.make("environment:queue-edit"),
    ThreadId.make("thread:queue-edit"),
  );
  expect(
    store.getComposerDraft(DraftId.make(`queued-edit:${scopedThreadKey(editRef)}:run:queued`)),
  ).toBeNull();
  expect(store.getComposerDraft(otherTarget)?.prompt).toBe("Other thread edit");
});

it("retains the edit while its run is still queued", async () => {
  setup();
  // Navigation is simulated by rerendering, without route consumers.
  await using screen = await render(<Editor queueState="queued" />, { router: false });
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.getByRole("textbox", { name: "Message" }).fill("Still queued");
  await screen.rerender(<div>Another thread</div>);
  await screen.rerender(<Editor queueState="queued" />);
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Still queued");
});

it.each(["missing", "running"] as const)(
  "does not recover a retained edit from a stale %s projection before synchronization",
  async (queueState) => {
    setup();
    // Navigation is simulated by rerendering, without route consumers.
    await using screen = await render(<Editor />, { router: false });
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await screen.getByRole("textbox", { name: "Message" }).fill("Keep the queued edit");
    await screen.rerender(<div>Another thread</div>);
    await screen.rerender(<Editor queueState={queueState} threadIsLive={false} />);
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    const ref = scopeThreadRef(
      EnvironmentId.make("environment:queue-edit"),
      ThreadId.make("thread:queue-edit"),
    );
    await vi.waitFor(() =>
      expect(
        useComposerDraftStore
          .getState()
          .getComposerDraft(DraftId.make(`queued-edit:${scopedThreadKey(ref)}:run:queued`))?.prompt,
      ).toBe("Keep the queued edit"),
    );
    await screen.rerender(<Editor queueState="queued" />);
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Keep the queued edit");
  },
);

it("recovers an expired edit only after the cached projection becomes live", async () => {
  setup();
  // Navigation is simulated by rerendering, without route consumers.
  await using screen = await render(<Editor />, { router: false });
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.getByRole("textbox", { name: "Message" }).fill("Recover after sync");
  await screen.rerender(<div>Another thread</div>);
  await screen.rerender(<Editor queueState="missing" threadIsLive={false} />);
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await screen.rerender(<Editor queueState="missing" />);
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Recover after sync");
});

it("does not copy an untouched queued message back into the composer", async () => {
  setup();
  // Navigation is simulated by rerendering, without route consumers.
  await using screen = await render(<Editor />, { router: false });
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.rerender(<div>Another thread</div>);
  await screen.rerender(<Editor queueState="running" />);
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  const ref = scopeThreadRef(
    EnvironmentId.make("environment:queue-edit"),
    ThreadId.make("thread:queue-edit"),
  );
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft(DraftId.make(`queued-edit:${scopedThreadKey(ref)}:run:queued`)),
  ).toBeNull();
});
