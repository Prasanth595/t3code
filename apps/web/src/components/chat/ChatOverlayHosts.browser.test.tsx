import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { MessageId, RunId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { openRevertConfirm, RevertConfirmHost } from "./ChatOverlayHosts";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const messageId = MessageId.make("message-1");
const STARTED_AT = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const dialog = () => document.querySelector('[role="alertdialog"]');

describe("RevertConfirmHost", () => {
  it("shows only its thread's request, confirms it once, and drops it when the thread changes", async () => {
    const onConfirm = vi.fn();
    const host = (threadKey: string) => (
      <AppAtomRegistryProvider>
        <RevertConfirmHost threadKey={threadKey} checkpoints={[]} runs={[]} onConfirm={onConfirm} />
      </AppAtomRegistryProvider>
    );
    await act(() => root.render(host("env:a")));

    await act(() => openRevertConfirm("env:b", { turnCount: 2, messageId }));
    expect(dialog()).toBeNull();

    await act(() => openRevertConfirm("env:a", { turnCount: 2, messageId }));
    const keep = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Revert and keep changes",
    );
    await act(() => keep?.click());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, false);
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await act(() => openRevertConfirm("env:a", { turnCount: 3, messageId }));
    expect(dialog()).not.toBeNull();
    await act(() => root.render(host("env:b")));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("counts a checkpoint captured while the dialog is open, and hedges after a failed run", async () => {
    const checkpoint = (turnCount: number, paths: string[]): ThreadCheckpointSummary => ({
      runId: RunId.make(`run-${turnCount}`),
      checkpointTurnCount: turnCount,
      checkpointRef: `checkpoint-${turnCount}` as never,
      status: "ready",
      files: paths.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
      assistantMessageId: null,
      completedAt: "2026-06-20T00:00:00.000Z",
    });
    const host = (
      checkpoints: ReadonlyArray<ThreadCheckpointSummary>,
      runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status" | "startedAt">> = [],
    ) => (
      <AppAtomRegistryProvider>
        <RevertConfirmHost
          threadKey="env:a"
          checkpoints={checkpoints}
          runs={runs}
          onConfirm={vi.fn()}
        />
      </AppAtomRegistryProvider>
    );
    const first = [checkpoint(1, ["a.ts"]), checkpoint(2, ["b.ts"])];
    await act(() => root.render(host(first)));
    await act(() => openRevertConfirm("env:a", { turnCount: 1, messageId }));
    expect(dialog()?.textContent).toContain("The agent changed 1 file since then.");

    await act(() => root.render(host([...first, checkpoint(3, ["c.ts", "d.ts"])])));
    expect(dialog()?.textContent).toContain("The agent changed 3 files since then.");

    // A failed run is never captured, so the count becomes a lower bound.
    await act(() =>
      root.render(
        host(
          [...first, checkpoint(3, ["c.ts", "d.ts"])],
          [{ ordinal: 4, status: "failed", startedAt: STARTED_AT }],
        ),
      ),
    );
    expect(dialog()?.textContent).toContain("The agent changed at least 3 files since then.");
  });
});
