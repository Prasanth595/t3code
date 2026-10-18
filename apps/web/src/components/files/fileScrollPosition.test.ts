import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { getFileScrollPosition, guardFileScrollTarget } from "./fileScrollPosition";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";

class ScrollContainer extends EventTarget {
  scrollTop = 0;
  isConnected = true;
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function renderFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

beforeEach(() => {
  frames.clear();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => vi.unstubAllGlobals());

describe("file scroll positions", () => {
  it("retains handled requests across tab switches but distinguishes a reopened file", () => {
    const ref = scopeThreadRef(EnvironmentId.make("reveal-test"), ThreadId.make("thread"));
    const store = useRightPanelStore.getState();
    const activeSurface = () =>
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
    store.openFile(ref, "file.ts", 40);
    const original = activeSurface();
    if (original?.kind !== "file") throw new Error("Expected an open file");
    const position = getFileScrollPosition("reveal-test:thread:/repo/file.ts");
    position.top = 10_000;
    position.handledRevealRequest = original;

    store.open(ref, "diff");
    store.activateSurface(ref, original.id);
    expect(position.handledRevealRequest).toBe(activeSurface());

    store.closeSurface(ref, original.id);
    store.openFile(ref, "file.ts", 87);
    const reopened = activeSurface();
    if (reopened?.kind !== "file") throw new Error("Expected a reopened file");
    expect(reopened.revealRequestId).toBe(original.revealRequestId);
    expect(position.handledRevealRequest).not.toBe(reopened);
    expect(getFileScrollPosition("reveal-test:thread:/repo/file.ts").top).toBe(10_000);
    store.removeThread(ref);
  });

  it("keeps positions separate across threads", () => {
    getFileScrollPosition("environment:thread-a:/repo/file.ts").top = 10_000;
    getFileScrollPosition("environment:thread-b:/repo/file.ts").top = 400;
    expect(getFileScrollPosition("environment:thread-a:/repo/file.ts").top).toBe(10_000);
    expect(getFileScrollPosition("environment:thread-b:/repo/file.ts").top).toBe(400);
  });

  it("holds the saved position through editor attachment but yields to user input", () => {
    const container = new ScrollContainer();
    const cancel = guardFileScrollTarget(container as unknown as HTMLElement, () => 10_000);
    renderFrame();
    container.scrollTop = 0;
    renderFrame();
    expect(container.scrollTop).toBe(10_000);

    container.dispatchEvent(new Event("pointerdown"));
    container.scrollTop = 800;
    renderFrame();
    expect(container.scrollTop).toBe(800);
    cancel();
  });

  it("cancels pending restoration when an editor is removed", () => {
    const container = new ScrollContainer();
    const cancel = guardFileScrollTarget(container as unknown as HTMLElement, () => 500);
    cancel();
    renderFrame();
    expect(frames.size).toBe(0);
    expect(container.scrollTop).toBe(0);
  });

  it("stops guarding once the editor has settled", () => {
    const container = new ScrollContainer();
    const cancel = guardFileScrollTarget(container as unknown as HTMLElement, () => 900);
    for (let frame = 0; frame < 20; frame++) renderFrame();
    expect(container.scrollTop).toBe(900);
    expect(frames.size).toBe(0);
    container.scrollTop = 300;
    renderFrame();
    expect(container.scrollTop).toBe(300);
    cancel();
  });
});
