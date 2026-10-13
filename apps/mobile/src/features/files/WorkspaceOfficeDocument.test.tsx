import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WorkspaceOfficeDocument } from "./WorkspaceOfficeDocument";
import { FilePreviewModal } from "../../components/FilePreviewModal";

vi.mock("react-native", () => ({ View: ({ children }: { children: unknown }) => children }));
vi.mock("../../components/EmptyState", () => ({
  EmptyState: ({ title, detail }: { title: string; detail: string }) => (
    <div>
      {title}: {detail}
    </div>
  ),
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const source = {
  name: "report.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  environmentId: EnvironmentId.make("test"),
  resource: {
    _tag: "workspace-file" as const,
    threadId: ThreadId.make("thread"),
    path: "/workspace/report.xlsx",
  },
};
it("keeps a useful save/share fallback when the device cannot open Office files", async () => {
  const onClose = vi.fn();
  await act(() => {
    renderer = create(<WorkspaceOfficeDocument source={source} onClose={onClose} />);
  });
  await act(() => {
    const modal = renderer!.root.findByType(FilePreviewModal);
    modal.props.onOpenError(new Error("Install a compatible viewer or use Save or share."));
    modal.props.onRequestClose();
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("No compatible document viewer");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Save or share");
});
it("returns from the file screen after a successful native visit", async () => {
  const onClose = vi.fn();
  await act(() => {
    renderer = create(<WorkspaceOfficeDocument source={source} onClose={onClose} />);
  });
  await act(() => renderer!.root.findByType(FilePreviewModal).props.onRequestClose());
  expect(onClose).toHaveBeenCalledOnce();
});
