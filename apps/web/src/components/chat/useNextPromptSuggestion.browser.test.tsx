import { Activity, StrictMode } from "react";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useNextPromptSuggestion } from "./useNextPromptSuggestion";

const mocks = vi.hoisted(() => ({ suggest: vi.fn(), canSuggest: true }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.canSuggest }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { suggestNextPrompt: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.suggest }));

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const messages = [
  {
    id: MessageId.make("reply-a"),
    role: "assistant" as const,
    text: "Done",
    runId: null,
    streaming: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  },
];

type Input = Parameters<typeof useNextPromptSuggestion>[0];
function Probe({ input }: { input: Input }) {
  const result = useNextPromptSuggestion(input);
  return <output>{result.suggestion ?? "none"}</output>;
}

function setup() {
  mocks.suggest.mockReset();
  mocks.canSuggest = true;
  let resolve!: (answer: { _tag: "Success"; value: { suggestion: string } }) => void;
  const promise = new Promise<{ _tag: "Success"; value: { suggestion: string } }>((done) => {
    resolve = done;
  });
  const pending = { promise, resolve };
  mocks.suggest.mockReturnValue(pending.promise);
  const input: Input = { environmentId, threadId, enabled: true, phase: "running", messages };
  return { input, pending };
}

describe("useNextPromptSuggestion", () => {
  it("keeps one in-flight request across effect teardown and replay", async () => {
    const { input, pending } = setup();
    const view = (phase: Input["phase"], hidden = false) => (
      <StrictMode>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <Probe input={{ ...input, phase }} />
        </Activity>
      </StrictMode>
    );
    await using screen = await render(view("running"));
    await screen.rerender(view("ready"));
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
    await screen.rerender(view("ready", true));
    await screen.rerender(view("ready"));
    await act(async () => {
      pending.resolve({ _tag: "Success", value: { suggestion: "Run tests" } });
    });
    await expect.element(screen.getByText("Run tests", { exact: true })).toBeVisible();
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
  });

  it("drops a received suggestion when the user leaves its reply", async () => {
    const { input, pending } = setup();
    await using screen = await render(<Probe input={input} />);
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await act(async () => {
      pending.resolve({ _tag: "Success", value: { suggestion: "Old suggestion" } });
    });
    await expect.element(screen.getByText("Old suggestion", { exact: true })).toBeVisible();
    await screen.rerender(
      <Probe input={{ ...input, threadId: ThreadId.make("thread-b"), phase: "ready" }} />,
    );
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await expect.element(screen.getByText("none", { exact: true })).toBeVisible();
  });

  it("does not request for a run that finished while another thread was open", async () => {
    const { input } = setup();
    await using screen = await render(<Probe input={input} />);
    await screen.rerender(
      <Probe input={{ ...input, threadId: ThreadId.make("thread-b"), phase: "ready" }} />,
    );
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("rejects a response after leaving and returning to the same reply", async () => {
    const { input, pending } = setup();
    await using screen = await render(<Probe input={input} />);
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await screen.rerender(
      <Probe input={{ ...input, threadId: ThreadId.make("thread-b"), phase: "ready" }} />,
    );
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await act(async () => {
      pending.resolve({ _tag: "Success", value: { suggestion: "Stale" } });
    });
    await expect.element(screen.getByText("none", { exact: true })).toBeVisible();
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
  });

  it("hides a received suggestion immediately when disabled or permission is revoked", async () => {
    const { input, pending } = setup();
    await using screen = await render(<Probe input={input} />);
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await act(async () => {
      pending.resolve({ _tag: "Success", value: { suggestion: "Run tests" } });
    });
    await expect.element(screen.getByText("Run tests", { exact: true })).toBeVisible();
    await screen.rerender(<Probe input={{ ...input, phase: "ready", enabled: false }} />);
    await expect.element(screen.getByText("none", { exact: true })).toBeVisible();
    mocks.canSuggest = false;
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await expect.element(screen.getByText("none", { exact: true })).toBeVisible();
  });

  it("does not reuse a suggestion for the same thread ID in another environment", async () => {
    const { input, pending } = setup();
    await using screen = await render(<Probe input={input} />);
    await screen.rerender(<Probe input={{ ...input, phase: "ready" }} />);
    await act(async () => {
      pending.resolve({ _tag: "Success", value: { suggestion: "Environment A" } });
    });
    await expect.element(screen.getByText("Environment A", { exact: true })).toBeVisible();
    await screen.rerender(
      <Probe
        input={{ ...input, environmentId: EnvironmentId.make("environment-b"), phase: "ready" }}
      />,
    );
    await expect.element(screen.getByText("none", { exact: true })).toBeVisible();
  });
});
