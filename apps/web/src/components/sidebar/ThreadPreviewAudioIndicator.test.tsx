// @vitest-environment jsdom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  resetPreviewStateForTests,
  setActivePreviewTab,
  type DesktopPreviewOverlay,
} from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { ThreadPreviewAudioIndicator } from "./ThreadPreviewAudioIndicator";

const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(ref.environmentId, ThreadId.make("thread-2"));
const remoteRef = scopeThreadRef(EnvironmentId.make("env-2"), ref.threadId);

function openTab(threadRef = ref, tabId = "tab-a") {
  applyPreviewServerSnapshot(threadRef, {
    threadId: threadRef.threadId,
    tabId,
    navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function audio(overrides: Partial<DesktopPreviewOverlay> = {}): DesktopPreviewOverlay {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: true,
    controller: "none",
    favicon: null,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  resetPreviewStateForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  resetPreviewStateForTests();
});

async function renderIndicators(refs: ScopedThreadRef[] = [ref]) {
  await act(() =>
    root.render(
      <AppAtomRegistryProvider>
        {refs.map((threadRef) => (
          <div key={threadRef.environmentId + threadRef.threadId}>
            <ThreadPreviewAudioIndicator threadRef={threadRef} />
          </div>
        ))}
      </AppAtomRegistryProvider>,
    ),
  );
}

function indicators() {
  return container.querySelectorAll('[role="img"][aria-label="Preview playing audio"]');
}

describe("ThreadPreviewAudioIndicator", () => {
  it("tracks background audio independently of the selected preview tab", async () => {
    await renderIndicators();
    expect(indicators()).toHaveLength(0);

    await act(() => {
      openTab();
      openTab(ref, "tab-b");
      applyPreviewDesktopState(ref, "tab-a", audio());
    });
    expect(indicators()).toHaveLength(1);

    await act(() => setActivePreviewTab(ref, "tab-a"));
    expect(indicators()).toHaveLength(1);

    await act(() => applyPreviewDesktopState(ref, "tab-a", audio({ audible: false })));
    expect(indicators()).toHaveLength(0);
  });

  it("ignores muted, detached, closed, and unknown preview tabs", async () => {
    openTab();
    await renderIndicators();

    await act(() => applyPreviewDesktopState(ref, "tab-a", audio({ audioMuted: true })));
    expect(indicators()).toHaveLength(0);
    await act(() => applyPreviewDesktopState(ref, "tab-a", audio()));
    expect(indicators()).toHaveLength(1);
    await act(() => applyPreviewDesktopState(ref, "tab-a", audio({ hasWebContents: false })));
    expect(indicators()).toHaveLength(0);
    await act(() => applyPreviewDesktopState(ref, "tab-a", audio()));
    expect(indicators()).toHaveLength(1);
    await act(() => beginPreviewSessionClose(ref, "tab-a"));
    expect(indicators()).toHaveLength(0);
    await act(() => applyPreviewDesktopState(ref, "unknown-tab", audio()));
    expect(indicators()).toHaveLength(0);
  });

  it("stays visible until every preview in the thread is silent or muted", async () => {
    openTab();
    openTab(ref, "tab-b");
    applyPreviewDesktopState(ref, "tab-a", audio());
    applyPreviewDesktopState(ref, "tab-b", audio());
    await renderIndicators();
    expect(indicators()).toHaveLength(1);

    await act(() => applyPreviewDesktopState(ref, "tab-b", audio({ audible: false })));
    expect(indicators()).toHaveLength(1);
    await act(() => applyPreviewDesktopState(ref, "tab-a", audio({ audioMuted: true })));
    expect(indicators()).toHaveLength(0);
  });

  it("identifies simultaneous noisy threads and scopes identical IDs by environment", async () => {
    for (const threadRef of [ref, otherRef, remoteRef]) openTab(threadRef);
    await renderIndicators([ref, otherRef, remoteRef]);

    await act(() => {
      applyPreviewDesktopState(ref, "tab-a", audio());
      applyPreviewDesktopState(remoteRef, "tab-a", audio());
    });
    expect(
      Array.from(container.children, (row) => row.querySelector('[role="img"]') !== null),
    ).toEqual([true, false, true]);

    await act(() => applyPreviewDesktopState(otherRef, "tab-a", audio()));
    expect(indicators()).toHaveLength(3);
    await act(() => applyPreviewDesktopState(ref, "tab-a", null));
    expect(indicators()).toHaveLength(2);
  });

  it("does not commit renders for unrelated preview updates or unchanged audio activity", async () => {
    openTab();
    openTab(otherRef);
    const commits: string[] = [];
    await act(() =>
      root.render(
        <AppAtomRegistryProvider>
          <Profiler id="indicator" onRender={(_, phase) => commits.push(phase)}>
            <ThreadPreviewAudioIndicator threadRef={ref} />
          </Profiler>
        </AppAtomRegistryProvider>,
      ),
    );
    commits.length = 0;

    for (let i = 0; i < 100; i++) {
      await act(() => {
        applyPreviewDesktopState(ref, "tab-a", audio({ audible: false, zoomFactor: i + 1 }));
        applyPreviewDesktopState(otherRef, "tab-a", audio({ audible: i % 2 === 0 }));
      });
    }
    expect(commits).toHaveLength(0);

    await act(() => applyPreviewDesktopState(ref, "tab-a", audio()));
    expect(indicators()).toHaveLength(1);
    expect(commits).toHaveLength(1);

    await act(() => applyPreviewDesktopState(ref, "tab-a", audio({ loading: true })));
    expect(commits).toHaveLength(1);
  });
});
