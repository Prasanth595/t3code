import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
const external = vi.hoisted(() => ({ choose: vi.fn(), open: vi.fn(), canRead: false }));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: external.choose },
    shell: { openExternal: external.open },
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => undefined }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mint }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => external.canRead,
  useEnvironmentScope: () => external.canRead,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

it("opens host media through server authorization before the client grant loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/repo"
          threadRef={threadRef}
          text="[Open image](/tmp/image.png)"
          onImageExpand={onImageExpand}
        />,
      );
    });
    await act(async () => {
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href === "/tmp/image.png");
      expect(link).toBeDefined();
      link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    );
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["/exports/report.html", "/exports/photo.png", "/exports/notes.txt"])(
  "opens %s from its thread context menu even without the integrated browser",
  async (path) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mint
      .mockReset()
      .mockResolvedValue(
        AsyncResult.success({ relativeUrl: "/api/assets/fresh/file", expiresAt: 1 }),
      );
    external.canRead = true;
    external.choose.mockReset().mockResolvedValue("open-external");
    external.open.mockReset().mockResolvedValue(undefined);
    const threadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
    };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown cwd="/repo" threadRef={threadRef} text={`[Open file](${path})`} />,
        );
      });
      await act(async () => {
        const link = renderer!.root.findAllByType("a").find((node) => node.props.href === path);
        expect(link).toBeDefined();
        link!.props.onContextMenu({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 30,
          clientY: 40,
        });
      });
      expect(external.choose).toHaveBeenCalledWith(
        expect.arrayContaining([{ id: "open-external", label: "Open in external browser" }]),
        { x: 30, y: 40 },
      );
      expect(mint).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: { resource: { _tag: "media-file", threadId: threadRef.threadId, path } },
      });
      expect(external.open).toHaveBeenCalledWith("https://host.test/api/assets/fresh/file");
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  },
);
