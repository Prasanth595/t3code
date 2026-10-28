import { act, createContext, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { setTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import type { FilePreviewSource } from "../../components/FilePreviewModal";

const { JSDOM } = NodeModule.createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

const state = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    shell: { temporary: true },
    shellAtom: Atom.make({ temporary: true }),
    listeners: new Set<() => void>(),
    detailReads: vi.fn(),
    assetUrl: vi.fn(() => null),
    alert: vi.fn(),
    openPullRequest: vi.fn(),
    copyContext: vi.fn(async () => {}),
    copyText: vi.fn(async (_text: string) => true),
    clearSizes: vi.fn(),
    projections: new Map<string, OrchestrationV2ThreadProjection>(),
  };
});
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: "span",
  ScrollView: "div",
  Image: { resolveAssetSource: () => null },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ScrollView: "div",
  },
  FadeIn: { duration: () => ({}), delay: () => ({ duration: () => ({}) }) },
  FadeInUp: { duration: () => ({}) },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({}),
  useFocusEffect: () => {},
}));
vi.mock("@react-navigation/elements", () => ({ HeaderHeightContext: createContext(0) }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@legendapp/list/react-native", () => ({ useViewabilityAmount: () => 1 }));
vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: (props: {
    data: readonly { id: string }[];
    getFixedItemSize: (item: { id: string }) => number | undefined;
    renderItem: (info: { item: { id: string }; index: number }) => ReactNode;
  }) =>
    props.data.map((item, index) => (
      <div key={item.id} data-row={item.id} style={{ height: props.getFixedItemSize(item) }}>
        {props.renderItem({ item, index })}
      </div>
    )),
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: async () => {},
  NotificationFeedbackType: { Success: "success" },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("expo-image", () => ({ Image: "img" }));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }));
vi.mock("../../state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useQuietThreadShell: () =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.shell,
      ),
    useLiveThreadLinkLabels: (markdown: string) => markdown,
    useThreadChipIcons: () => new Map(),
  };
});
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: state.shell }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#ffffff" }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light", appearance: { baseFontSize: 14 } }),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: {
    markdown: string;
    renderImage: (image: { href: string; alt: string }) => ReactNode;
    onLinkPress: (href: string) => void;
    onFileContextMenuAction: (href: string, actionId: string) => void;
    contextClipboardFragment?: string;
  }) => (
    <>
      <button aria-label="Open link" onClick={() => props.onLinkPress("https://example.test/link")}>
        Open link
      </button>
      {props.markdown === "Image"
        ? props.renderImage({ href: "https://example.test/markdown.png", alt: "Markdown image" })
        : null}
      {props.markdown === "Copy context" ? (
        <button
          aria-label="Copy context"
          data-context-fragment={props.contextClipboardFragment}
          onClick={() =>
            props.onFileContextMenuAction(
              "t3-context://v1/terminal/private-context",
              "copy-context",
            )
          }
        >
          Copy context
        </button>
      ) : null}
    </>
  ),
}));
vi.mock("./ThreadMarkdownImage", () => ({
  MarkdownImageAvailableWidthContext: createContext(400),
  ThreadMarkdownImage: (props: { alt?: string }) => <img alt={props.alt} />,
  ThreadMarkdownImageView: (props: { alt?: string }) => <img alt={props.alt} />,
  ThreadMarkdownImageUnavailable: () => null,
}));
vi.mock("./ThreadMarkdownVideo", () => ({
  ThreadMarkdownVideo: () => null,
  ThreadMediaVisibleContext: createContext(true),
}));
vi.mock("./thread-work-log", () => ({
  THREAD_DISCLOSURE_TRANSITION_MS: 0,
  WORK_GROUP_TOGGLE_HEIGHT: 40,
  collapsedWorkLogHeight: () => 40,
  ThreadWorkLog: (props: {
    renderImage: (image: { href: string }) => ReactNode;
    onPressPreview: (source: FilePreviewSource) => void;
  }) => (
    <>
      <button
        aria-label="Open media"
        onClick={() =>
          props.onPressPreview({ kind: "image", uri: "https://example.test/preview.png" })
        }
      >
        Open media
      </button>
      {props.renderImage({ href: "viewed.png" })}
    </>
  ),
}));
vi.mock("./HtmlRenderWebView", () => ({
  ThreadHtmlRender: () => <div>HTML media</div>,
  htmlRenderRowHeight: () => 100,
}));
vi.mock("./McpAppWebView", () => ({ ThreadMcpApp: () => <div>MCP media</div> }));
vi.mock("./LinkRequestCard", () => ({ LinkRequestCard: () => null }));
vi.mock("../../lib/threadActivity", () => ({
  createThreadFeedCache: () => ({}),
  deriveThreadFeedPresentation: (feed: unknown) => feed,
  threadFeedCompactionLabels: () => new Map(),
  failedFeedRunIds: () => new Set(),
  threadFeedRunIsUnsettled: () => false,
  isContextCompactionActivityGroup: () => false,
  isContextHandoffActivityGroup: () => false,
  isSecretRequestActivityGroup: () => false,
  isLinkRequestActivityGroup: () => false,
}));
vi.mock("./pending-thread-feed", () => ({
  appendGuestPendingMessages: (feed: unknown) => feed,
  appendPendingThreadMessages: (feed: unknown) => feed,
  isCompactionCommandFeedEntry: () => false,
}));
vi.mock("@t3tools/client-runtime/work-log/presentation", () => ({
  resolveViewedImageAsset: () => ({ resource: {}, alt: "Viewed image" }),
}));
vi.mock("../../components/FilePreviewGallery", () => ({
  FilePreviewGallery: ({ children }: { children: ReactNode }) => children,
  useFilePreviewGallery: () => ({}),
}));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./SubagentRow", () => ({ SubagentRow: () => null }));
vi.mock("./work-log-layout", () => ({
  WorkLogBlock: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./useFileChipShare", () => ({ useFileChipShare: () => () => {} }));
vi.mock("../../native/useMarkdownImageSource", () => ({
  useMarkdownImageSource: () => async () => null,
}));
vi.mock("../review/ReviewCommentCard", () => ({
  useReviewCommentColors: () => ({}),
  ReviewCommentCard: () => null,
}));
vi.mock("../../state/assets", () => ({
  assetEnvironment: {},
  useAssetUrl: () => state.assetUrl(),
  useAssetUrlState: () => ({}),
  useRefreshAssetUrl: () => () => {},
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  usePreparedConnection: () => Option.none(),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/threads", async () => {
  const { createEnvironmentThreadDetailAtoms, EMPTY_ENVIRONMENT_THREAD_STATE } =
    await import("@t3tools/client-runtime/state/threads");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const stateAtom = Atom.family((threadId: string) =>
    Atom.make(() => {
      state.detailReads(threadId);
      return AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        data: Option.fromNullishOr(state.projections.get(threadId)),
      });
    }),
  );
  return {
    environmentThreadShells: { quietThreadShellAtom: () => state.shellAtom },
    threadEnvironment: {},
    environmentThreadDetails: createEnvironmentThreadDetailAtoms((_, threadId) =>
      stateAtom(threadId),
    ),
  };
});
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../components/ComposerContextSheet", () => ({ ComposerContextSheet: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/FilePreviewModal", () => ({
  FilePreviewModal: (props: { source: FilePreviewSource | null; onRequestClose: () => void }) =>
    props.source ? (
      <button aria-label="Close media preview" onClick={props.onRequestClose}>
        Close media preview
      </button>
    ) : null,
}));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/VideoAttachmentTile", () => ({ VideoAttachmentTile: () => null }));
vi.mock("../../components/MediaVideoPlayer", () => ({ MediaVideoPlayer: () => null }));
vi.mock("./ThreadInlineFilePreview", () => ({ ThreadInlineFilePreview: () => null }));
vi.mock("./CopyTextButton", () => ({
  CopyTextButton: (props: {
    accessibilityLabel: string;
    text: string;
    onCopy?: () => Promise<void>;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      onClick={async () => {
        if (props.onCopy) await props.onCopy();
        else await state.copyText(props.text);
      }}
    >
      Copy
    </button>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("./thread-context-divider", () => ({ ThreadContextDivider: () => null }));
vi.mock("./thread-handoff-row", () => ({
  ThreadHandoffDivider: () => null,
  ThreadHandoffRow: () => null,
}));
vi.mock("./SecretRequestCard", () => ({ SecretRequestCard: () => null }));
vi.mock("./worktree-setup-card", () => ({
  WorktreeWorkingHeader: () => null,
  WorktreeSetupCard: () => null,
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: () => null }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollViewMarker: () => null }));
vi.mock("../../lib/composerContextClipboard", () => ({
  writeComposerContextClipboard: state.copyContext,
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({
  copyTextWithHaptic: () => null,
  tryCopyTextWithHaptic: state.copyText,
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => null }));
vi.mock("../../lib/attachmentDownload", () => ({ downloadAndShareAttachment: () => null }));
vi.mock("../review/reviewState", () => ({ setReviewSelectedSectionId: () => null }));
vi.mock("../prompt-links/prompt-link-actions", () => ({ copyPromptLink: () => null }));
vi.mock("../../native/useEnrichedLinkVariants", () => ({
  enrichedContextLinkCustomization: () => null,
  enrichedThreadLinkCustomization: () => null,
  withChipIcon: () => null,
}));
vi.mock("./markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: () => null }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("../../state/v2-item-support", () => ({ useV2ItemSupport: () => null }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => null }));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => state.openPullRequest,
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => null,
}));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => null }));
vi.mock("../layout/workspace-content-width", () => ({
  useWorkspaceSettledContentWidth: () => 400,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { v2Projection } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { ThreadFeed } from "./ThreadFeed";
import { useWorkflowOpening } from "./thread-workflow-opening";

it.each([true, false])(
  "admits workflow detail and guards media and links through Keep with shell temporary=%s",
  async (temporary) => {
    const environmentId = EnvironmentId.make("env");
    const threadId = ThreadId.make("thread");
    state.shell = { temporary };
    state.listeners.clear();
    state.detailReads.mockClear();
    state.assetUrl.mockClear();
    state.alert.mockClear();
    state.openPullRequest.mockClear();
    state.copyContext.mockClear();
    state.copyText.mockClear();
    state.clearSizes.mockClear();
    state.projections.clear();
    const registry = AtomRegistry.make();
    registry.set(state.shellAtom, state.shell);
    setTemporaryThread(environmentId, threadId, true);
    const dom = new JSDOM("<html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const feed = [
      { id: "html", type: "html-render", render: {} },
      { id: "mcp", type: "mcp-app", app: { attachmentId: "mcp" } },
      {
        id: "image",
        type: "message",
        message: {
          id: "image",
          role: "assistant",
          text: "Image",
          createdAt: "2026-10-24T00:00:00Z",
          updatedAt: "2026-10-24T00:00:00Z",
        },
      },
      { id: "viewed", type: "activity-group", activities: [], continuesWorkLog: false },
      {
        id: "context-message",
        type: "message",
        message: {
          id: "context-message",
          role: "user",
          text: "Copy context",
          attachments: [
            { id: "private-image", type: "image", name: "private.png", mimeType: "image/png" },
            {
              id: "private-file",
              type: "file",
              name: "private.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 1,
            },
          ],
          context: {
            version: 1,
            records: [
              {
                version: 1,
                kind: "terminal",
                contextId: "private-context",
                label: "Terminal",
                terminalId: "terminal",
                terminalLabel: "Terminal",
                lineStart: 1,
                lineEnd: 1,
                text: "private clipboard sentinel",
              },
            ],
          },
          createdAt: "2026-10-24T00:00:00Z",
          updatedAt: "2026-10-24T00:00:00Z",
        },
      },
    ] as unknown as ComponentProps<typeof ThreadFeed>["feed"];
    const feedView = (
      <ThreadFeed
        environmentId={environmentId}
        threadId={threadId}
        detailRef={null}
        threadTitle="Thread"
        feed={feed}
        queuedMessages={[]}
        dispatchingMessageId={null}
        onEditPendingMessage={() => {}}
        contentPresentation={{ kind: "ready" }}
        latestRun={null}
        activeWorkStartedAt={null}
        listRef={
          {
            current: {
              clearCaches: state.clearSizes,
              flashScrollIndicators: vi.fn(),
              getAnimatableRef: vi.fn<LegendListRef["getAnimatableRef"]>(),
              getNativeScrollRef: vi.fn<LegendListRef["getNativeScrollRef"]>(),
              getScrollableNode: vi.fn(),
              getScrollResponder: vi.fn<LegendListRef["getScrollResponder"]>(),
              getState: vi.fn<LegendListRef["getState"]>(),
              reportContentInset: vi.fn(),
              scrollIndexIntoView: vi.fn<LegendListRef["scrollIndexIntoView"]>(),
              scrollItemIntoView: vi.fn<LegendListRef["scrollItemIntoView"]>(),
              scrollToEnd: vi.fn<LegendListRef["scrollToEnd"]>(),
              scrollToIndex: vi.fn<LegendListRef["scrollToIndex"]>(),
              scrollToItem: vi.fn<LegendListRef["scrollToItem"]>(),
              scrollToOffset: vi.fn<LegendListRef["scrollToOffset"]>(),
              setItemSize: vi.fn(),
              setScrollProcessingEnabled: vi.fn(),
              setVisibleContentAnchorOffset: vi.fn(),
            },
          } satisfies ComponentProps<typeof ThreadFeed>["listRef"]
        }
        freeze={{ value: false } as ComponentProps<typeof ThreadFeed>["freeze"]}
        anchorMessageId={null}
        contentInsetEndAdjustment={
          { value: 0 } as ComponentProps<typeof ThreadFeed>["contentInsetEndAdjustment"]
        }
        keyboardOffset={0}
      />
    );
    const copyMessage = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click();
      });
    };
    const copyContext = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Copy context"]')!.click();
      });
    };
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>{feedView}</RegistryContext.Provider>,
        ),
      );
      expect(state.detailReads).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <ThreadFeed {...feedView.props} threadTitle="Pending creation" />
          </RegistryContext.Provider>,
        ),
      );
      expect(state.detailReads).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <ThreadFeed {...feedView.props} detailRef={{ environmentId, threadId }} />
          </RegistryContext.Provider>,
        ),
      );
      expect(state.detailReads.mock.calls).toEqual([[threadId]]);
      expect(state.assetUrl).not.toHaveBeenCalled();
      expect(container.textContent?.match(/Keep thread to open media/g)).toHaveLength(6);
      expect(container.querySelectorAll("img")).toHaveLength(0);
      expect.soft(container.querySelector<HTMLElement>('[data-row="html"]')?.style.height).toBe("");
      expect
        .soft(
          container
            .querySelector('[aria-label="Copy context"]')
            ?.getAttribute("data-context-fragment"),
        )
        .toBeNull();
      await copyContext();
      expect.soft(state.copyContext).not.toHaveBeenCalled();
      state.copyContext.mockClear();
      state.alert.mockClear();
      await copyMessage();
      expect.soft(state.copyContext).not.toHaveBeenCalled();
      expect.soft(state.copyText).toHaveBeenCalledWith("Copy context");
      state.copyContext.mockClear();
      state.copyText.mockClear();
      await act(async () => {
        setTemporaryThread(environmentId, threadId, false);
      });
      if (temporary) {
        await copyContext();
        expect.soft(state.copyContext).not.toHaveBeenCalled();
        state.copyContext.mockClear();
        state.alert.mockClear();
        await copyMessage();
        expect.soft(state.copyContext).not.toHaveBeenCalled();
        expect.soft(state.copyText).toHaveBeenCalledWith("Copy context");
        state.copyContext.mockClear();
        state.copyText.mockClear();
        await act(async () => {
          container.querySelector<HTMLButtonElement>('[aria-label="Open link"]')!.click();
          container.querySelector<HTMLButtonElement>('[aria-label="Open media"]')!.click();
        });
        expect.soft(state.openPullRequest).not.toHaveBeenCalled();
        expect.soft(container.textContent).not.toContain("Close media preview");
        expect.soft(state.alert).toHaveBeenCalledTimes(2);
        state.alert.mockClear();
      }
      await act(async () => {
        state.shell = { temporary: false };
        registry.set(state.shellAtom, state.shell);
        for (const listener of state.listeners) listener();
      });
      expect(state.assetUrl).toHaveBeenCalled();
      expect(container.textContent).toContain("private.bin");
      expect(container.textContent).not.toContain("Keep thread to open media");
      expect(container.textContent).toContain("HTML media");
      expect(container.textContent).toContain("MCP media");
      expect
        .soft(container.querySelector<HTMLElement>('[data-row="html"]')?.style.height)
        .toBe("100px");
      expect.soft(state.clearSizes).toHaveBeenCalledWith({ mode: "sizes" });
      expect
        .soft(
          container
            .querySelector('[aria-label="Copy context"]')
            ?.getAttribute("data-context-fragment"),
        )
        .toContain("private clipboard sentinel");
      await copyContext();
      expect.soft(state.copyContext).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          records: [expect.objectContaining({ text: "private clipboard sentinel" })],
        }),
      );
      state.copyContext.mockClear();
      expect(Array.from(container.querySelectorAll("img"), (image) => image.alt)).toEqual([
        "Markdown image",
        "Viewed image",
      ]);
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Open link"]')!.click();
        container.querySelector<HTMLButtonElement>('[aria-label="Open media"]')!.click();
      });
      expect(state.openPullRequest.mock.calls).toEqual([["https://example.test/link"]]);
      expect(container.textContent).toContain("Close media preview");
      expect(state.alert).not.toHaveBeenCalled();
      await copyMessage();
      expect(state.copyContext).toHaveBeenCalledWith(
        "Copy context",
        expect.objectContaining({
          records: [expect.objectContaining({ text: "private clipboard sentinel" })],
        }),
      );
      expect(state.copyText).not.toHaveBeenCalled();
      state.copyContext.mockClear();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Close media preview"]')!.click();
      });
      state.openPullRequest.mockClear();
      setTemporaryThread(environmentId, threadId, true);
      await copyContext();
      expect.soft(state.copyContext).not.toHaveBeenCalled();
      state.copyContext.mockClear();
      state.alert.mockClear();
      await copyMessage();
      expect.soft(state.copyContext).not.toHaveBeenCalled();
      expect.soft(state.copyText).toHaveBeenCalledWith("Copy context");
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Open link"]')!.click();
        container.querySelector<HTMLButtonElement>('[aria-label="Open media"]')!.click();
      });
      expect(state.openPullRequest).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Close media preview");
      expect(state.alert).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      registry.dispose();
      setTemporaryThread(environmentId, threadId, false);
      vi.unstubAllGlobals();
      dom.window.close();
    }
  },
);

function WorkflowReader(props: { readonly detailRef: ScopedThreadRef | null }) {
  const opening = useWorkflowOpening(props.detailRef);
  return <span>{opening?.script}</span>;
}

it("loads the workflow and its parent after detail admission", async () => {
  const environmentId = EnvironmentId.make("env");
  const threadId = ThreadId.make("workflow");
  const parentId = ThreadId.make("parent");
  const script = 'export const meta = { name: "probe" };';
  state.detailReads.mockClear();
  state.projections.clear();
  state.projections.set(threadId, {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      id: threadId,
      creationSource: "provider",
      lineage: {
        parentThreadId: parentId,
        rootThreadId: parentId,
        relationshipToParent: "subagent",
      },
    },
    messages: [
      {
        id: MessageId.make("script"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: script,
        workflowScript: true,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "mobile",
        createdAt: v2Projection.updatedAt,
        updatedAt: v2Projection.updatedAt,
      },
    ],
  });
  state.projections.set(parentId, v2Projection);
  const registry = AtomRegistry.make();
  const dom = new JSDOM("<html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <WorkflowReader detailRef={null} />
        </RegistryContext.Provider>,
      ),
    );
    expect(state.detailReads).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <WorkflowReader detailRef={{ environmentId, threadId }} />
        </RegistryContext.Provider>,
      ),
    );
    expect(state.detailReads.mock.calls).toEqual([[threadId], [parentId]]);
    expect(container.textContent).toBe(script);
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
    dom.window.close();
  }
});
