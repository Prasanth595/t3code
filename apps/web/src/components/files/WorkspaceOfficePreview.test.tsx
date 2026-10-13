import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkspaceOfficePreview } from "./WorkspaceOfficePreview";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("~/assets/assetUrls", () => ({ useAssetRefresh: () => refresh }));
vi.mock("./OfficeFilePreview", () => ({
  OfficeFilePreview: ({ src }: { src: string }) => {
    const [sheet, setSheet] = useState("First");
    return <select aria-label={src} value={sheet} onChange={() => setSheet("Second")} />;
  },
}));
vi.mock("./fileSurfaceChrome", () => ({
  FileSurfaceLoading: () => <div>Loading</div>,
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
}));

describe("Office workspace refresh", () => {
  let renderer: ReactTestRenderer | undefined;
  const props = {
    environmentId: EnvironmentId.make("test-environment"),
    threadRef: {
      environmentId: EnvironmentId.make("test-environment"),
      threadId: ThreadId.make("thread-1"),
    },
    draft: false,
    absolutePath: "/workspace/report.xlsx",
    workspaceRoot: "/workspace",
    name: "report.xlsx",
    kind: "xlsx" as const,
    workspaceMutationId: null as string | null,
    refreshRevision: 0,
  };
  const render = async (overrides = {}) => {
    await act(async () => {
      if (renderer) renderer.update(<WorkspaceOfficePreview {...props} {...overrides} />);
      else renderer = create(<WorkspaceOfficePreview {...props} {...overrides} />);
      await vi.advanceTimersByTimeAsync(150);
    });
    await act(() => vi.advanceTimersByTimeAsync(150));
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    refresh.mockReset().mockResolvedValue({
      url: "https://host.test/report.xlsx",
      fileVersion: "version-1",
      byteLength: 123,
    });
  });
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("preserves the chosen worksheet after an unchanged workspace command", async () => {
    await render();
    await act(() => renderer!.root.findByType("select").props.onChange());
    refresh.mockResolvedValue({
      url: "https://host.test/renewed.xlsx",
      fileVersion: "version-1",
      byteLength: 123,
    });
    await render({ workspaceMutationId: "read-only-command" });
    expect(renderer!.root.findByType("select").props.value).toBe("Second");
    expect(renderer!.root.findByType("select").props["aria-label"]).toContain("report.xlsx");
  });
  it("reloads changed content and explicit refreshes", async () => {
    await render();
    await act(() => renderer!.root.findByType("select").props.onChange());
    refresh.mockResolvedValue({
      url: "https://host.test/changed.xlsx",
      fileVersion: "version-2",
      byteLength: 123,
    });
    await render({ workspaceMutationId: "file-update" });
    expect(renderer!.root.findByType("select").props.value).toBe("First");
    await act(() => renderer!.root.findByType("select").props.onChange());
    await render({ workspaceMutationId: "file-update", refreshRevision: 1 });
    expect(renderer!.root.findByType("select").props.value).toBe("First");
  });
  it("does not replace a successful preview while an update check is pending", async () => {
    await render();
    await act(() => renderer!.root.findByType("select").props.onChange());
    refresh.mockImplementation(() => new Promise(() => {}));
    await render({ workspaceMutationId: "another-command" });
    expect(renderer!.root.findByType("select").props.value).toBe("Second");
  });
});
