import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useTimelineRewind } from "./useTimelineRewind";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  waitForShell: vi.fn(),
}));

vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../state/assets", () => ({ assetEnvironment: {} }));
vi.mock("../../state/entities", () => ({ waitForThreadShell: mocks.waitForShell }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.fork }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../localApi", () => ({ readLocalApi: () => null }));
vi.mock("../../session-logic", () => ({ findRevertCheckpoint: () => null }));
vi.mock("../ChatView.logic", () => ({ makeThreadErrorSetter: () => vi.fn() }));
vi.mock("./ChatOverlayHosts", () => ({ openRevertConfirm: vi.fn() }));
vi.mock("./chatViewSend", () => ({ rewindToMessage: vi.fn() }));

const environmentId = EnvironmentId.make("fork-test");
const sourceThreadId = ThreadId.make("parent");
const sourceRef = scopeThreadRef(environmentId, sourceThreadId);
const draftPrompt = "From a side question:\n\n> **Q:** Where is the parser?\n>\n> In parser.ts\n\n";

function setup() {
  mocks.fork.mockReset();
  mocks.waitForShell.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  return vi.fn();
}

function Harness({ setThreadError }: { setThreadError: ReturnType<typeof setup> }) {
  const { onForkFromRunStable } = useTimelineRewind({
    environmentId,
    routeThreadRef: sourceRef,
    routeThreadKey: "fork-test:parent",
    currentRouteThreadKeyRef: { current: "fork-test:parent" },
    serverProjection: null,
    activeThread: { id: sourceThreadId, title: "Parser work" } as never,
    timelineMessages: [],
    paintOnlyDisplayedTimeline: false,
    phase: "ready",
    isConnecting: false,
    isSendBusy: false,
    isRevertingCheckpoint: false,
    supportsConversationRollback: true,
    activeEnvironmentUnavailable: false,
    activeEnvironmentUnavailableLabel: null,
    promptRef: { current: "" },
    composerRef: { current: null },
    composerDraftTarget: sourceRef,
    setThreadError,
  });
  return (
    <button
      onClick={() =>
        void onForkFromRunStable({ sourceThreadId, runId: RunId.make("run"), draftPrompt })
      }
    >
      Fork with answers
    </button>
  );
}

it("opens the new thread with the answers in its composer draft", async () => {
  const setThreadError = setup();
  mocks.fork.mockResolvedValue(AsyncResult.success(undefined));
  mocks.waitForShell.mockResolvedValue(true);
  await using screen = await render(<Harness setThreadError={setThreadError} />);
  await page.getByRole("button", { name: "Fork with answers" }).click();
  await vi.waitFor(() => expect(mocks.waitForShell).toHaveBeenCalled());
  const targetThreadId = mocks.fork.mock.calls[0]?.[0].input.targetThreadId;
  expect(targetThreadId).toBeTypeOf("string");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/fork-test/${targetThreadId}`),
  );
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, targetThreadId))
      ?.prompt,
  ).toBe(draftPrompt);
  expect(setThreadError).not.toHaveBeenCalled();
});

it("retains the fork's answer draft even if shell synchronization times out", async () => {
  const setThreadError = setup();
  mocks.fork.mockResolvedValue(AsyncResult.success(undefined));
  mocks.waitForShell.mockResolvedValue(false);
  await using screen = await render(<Harness setThreadError={setThreadError} />);
  await page.getByRole("button", { name: "Fork with answers" }).click();
  await vi.waitFor(() => expect(setThreadError).toHaveBeenCalled());
  const targetThreadId = mocks.fork.mock.calls[0]?.[0].input.targetThreadId;
  expect(targetThreadId).toBeTypeOf("string");
  expect(mocks.fork.mock.calls[0]?.[0]).toEqual({
    environmentId,
    input: {
      sourceThreadId,
      targetThreadId,
      runId: "run",
      title: "Parser work fork",
    },
  });
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, targetThreadId))
      ?.prompt,
  ).toBe(draftPrompt);
  expect(screen.router?.state.location.pathname).toBe("/");
});

it("does not create an answer draft or navigate when the server refuses the fork", async () => {
  const setThreadError = setup();
  mocks.fork.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Fork refused"))));
  await using screen = await render(<Harness setThreadError={setThreadError} />);
  await page.getByRole("button", { name: "Fork with answers" }).click();
  await vi.waitFor(() =>
    expect(setThreadError).toHaveBeenCalledWith(sourceThreadId, "Fork refused"),
  );
  expect(mocks.waitForShell).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
  expect(screen.router?.state.location.pathname).toBe("/");
});
