import {
  ProviderInstanceId,
  type PullRequestListEntry,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  guide: null as unknown,
  settings: null as unknown,
  permission: null as unknown,
  empty: null as unknown,
  refresh: vi.fn(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  const { useMemo } = await import("react");
  return {
    ...actual,
    useAtomRefresh: (atom: Parameters<typeof actual.useAtomRefresh>[0]) => {
      const refresh = actual.useAtomRefresh(atom);
      return useMemo(
        () => () => {
          if (atom === mocks.guide) mocks.refresh();
          refresh();
        },
        [atom, refresh],
      );
    },
  };
});
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  const core: typeof import("@react-navigation/native") = nativeRequire("@react-navigation/core");
  return {
    NavigationContext: core.NavigationContext,
    useFocusEffect: core.useFocusEffect,
    useNavigation: core.useNavigation,
    StackActions: core.StackActions,
  };
});
vi.mock("react-native", () => {
  const View = ({
    children,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    accessibilityElementsHidden?: boolean;
  }) => <div hidden={accessibilityElementsHidden}>{children}</div>;
  return {
    View,
    ScrollView: View,
    Pressable: View,
    RefreshControl: () => null,
    Platform: { OS: "ios" },
    StyleSheet: { absoluteFill: {} },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  FadeIn: { delay: () => ({ duration: () => ({ reduceMotion: () => ({}) }) }) },
  ReduceMotion: { System: "system" },
}));
vi.mock("@legendapp/list/reanimated", () => ({
  // Render retained rows across section changes; native list virtualization is parent-owned proof.
  AnimatedLegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
  }: {
    data: { key: string; content: ReactNode }[];
    renderItem: (row: { item: { key: string; content: ReactNode } }) => ReactNode;
    ListHeaderComponent: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item) => (
        <div key={item.key}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-clipboard", () => ({}));
vi.mock("../pullRequestLink", () => ({
  copyPullRequestLink: () => {},
  sharePullRequestLink: () => {},
}));
vi.mock("@pierre/diffs/utils/parsePatchFiles", () => ({ parsePatchFiles: () => [] }));
vi.mock("@t3tools/client-runtime/source-control-clients", () => ({
  sourceControlClients: { get: () => ({ changeRequest: { singular: "pull request" } }) },
  capitalizeTerm: (term: string) => term,
}));
vi.mock("../../../state/pull-requests", () => ({
  composerPullRequests: {
    reviewGuide: () => mocks.guide,
    detail: () => mocks.empty,
    activity: () => mocks.empty,
    generateReviewGuide: { permissionAtom: () => mocks.permission },
  },
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: () => mocks.settings },
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../../state/use-pull-to-refresh", () => ({
  usePullToRefresh: () => ({ refreshing: false }),
}));
vi.mock("../../../components/ui/Toolbar", () => {
  const Empty = () => null;
  return { Toolbar: Object.assign(Empty, { Menu: Empty, MenuAction: Empty, Label: Empty }) };
});
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../../components/ui/SegmentedControl", () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: { value: string; label: string }[];
    onSelect: (value: string) => void;
  }) => (
    <nav>
      {options.map((option) => (
        <button type="button" key={option.value} onClick={() => onSelect(option.value)}>
          {option.label}
        </button>
      ))}
    </nav>
  ),
}));
vi.mock("../../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../native/NativeScrollViewMarker", () => ({
  NativeScrollViewMarker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ buttonSize: 32 }),
}));
vi.mock("../../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../../layout/useWorkspaceSidebarHeaderItem", () => ({
  useWorkspaceSidebarHeaderItem: () => null,
}));
vi.mock("../../workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: () => vi.fn(),
}));
vi.mock("../usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("../usePullRequestLiveChecks", () => ({ usePullRequestLiveChecks: () => null }));
vi.mock("../usePullRequestEnvironmentFallback", () => ({
  usePullRequestEnvironmentFallback: () => null,
}));
vi.mock("../usePullRequestPermissions", () => ({
  usePullRequestPermissions: () => ({ verdicts: [] }),
}));
vi.mock("../usePullRequestAction", () => ({ usePullRequestAction: () => ({}) }));
vi.mock("../usePullRequestStack", () => ({ usePullRequestStack: () => ({}) }));
vi.mock("../PullRequestFiles", () => ({ usePullRequestFilesSection: () => ({ rows: [] }) }));
vi.mock("../PullRequestTimeline", () => ({ pullRequestTimelineRows: () => [] }));
vi.mock("../PullRequestMarkdown", () => ({
  PullRequestMarkdownRepository: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PullRequestMarkdown: () => null,
}));
vi.mock("../PullRequestMedia", async () => ({
  PullRequestMediaVisibleContext: (await import("react")).createContext(true),
}));
vi.mock("../usePullRequestDiff", () => ({
  pullRequestTarget: (params: unknown) => params,
  usePullRequestDiff: () => ({ patch: "", parsed: { kind: "files", files: [] } }),
}));
vi.mock("../../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: {} }),
}));
vi.mock("./GuideOutline", () => ({
  GuideOutline: ({ guide }: { guide: { headSha: string } }) => <p>Cached guide {guide.headSha}</p>,
}));
vi.mock("../../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => null,
}));
vi.mock("../../../components/ui/Chip", () => ({ Chip: () => null }));
vi.mock("../../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../layout/workspace-sidebar-toolbar", () => ({
  AndroidWorkspaceSidebarButton: () => null,
}));
vi.mock("../PullRequestActivityFilters", () => ({ PullRequestActivityFilters: () => null }));
vi.mock("../PullRequestOverviewLoading", () => ({ PullRequestOverviewLoading: () => null }));
vi.mock("../PullRequestPresentation", () => ({
  PullRequestAvatar: () => null,
  PullRequestDiffStats: () => null,
  PullRequestReadStatus: () => null,
}));
vi.mock("../PullRequestControls", () => ({
  PullRequestActionToolbar: () => null,
  PullRequestCardGroup: () => null,
  PullRequestCardRow: () => null,
}));
vi.mock("../PullRequestStatusRows", () => ({
  PullRequestStatusMenu: () => null,
  PullRequestChecksRow: () => null,
  PullRequestBranchRow: () => null,
  PullRequestReviewersRow: () => null,
}));
vi.mock("../PullRequestMergeControls", () => ({ PullRequestMergeControls: () => null }));
vi.mock("../PullRequestStackCard", () => ({ PullRequestStackCard: () => null }));
vi.mock("../PullRequestReactions", () => ({ PullRequestReactions: () => null }));
vi.mock("../PullRequestDescription", () => ({ PullRequestDescription: () => null }));
vi.mock("./ReviewGuideExcerpt", () => ({ ReviewGuideExcerpt: () => null }));
vi.mock("../usePullRequestReviewDraft", () => ({ usePullRequestReviewDraft: () => null }));
vi.mock("../usePullRequestFilesViewed", () => ({ usePullRequestFilesViewed: () => null }));
vi.mock("../usePullRequestFileFilter", () => ({ usePullRequestFileFilter: () => null }));
vi.mock("../usePullRequestDiffHighlightFiles", () => ({
  usePullRequestDiffHighlightFiles: () => null,
}));
vi.mock("../../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => null,
}));
vi.mock("../../review/useNativeReviewDiffBridge", () => ({
  useNativeReviewDiffBridge: () => null,
}));
vi.mock("../../diffs/nativeReviewDiffSurface", () => ({ resolveNativeReviewDiffView: () => null }));
vi.mock("../../review/nativeReviewDiffAdapter", () => ({
  getCachedNativeReviewDiffData: () => null,
}));
vi.mock("../pullRequestAnimations", () => ({
  PR_ROW_LAYOUT: {},
  PR_ROW_ENTER: {},
  PR_ROW_EXIT: {},
  PR_POSITION_LAYOUT: {},
}));

import { PullRequestRouteScreen } from "../PullRequestRouteScreen";
import { PullRequestGuideStopScreen } from "./PullRequestGuideScreen";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.refresh = vi.fn();
  const initial: PullRequestReviewGuideResult = {
    currentHeadSha: "cached-head",
    guide: {
      headSha: "cached-head",
      generatedAt: "2026-10-26T00:00:00Z",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      stops: [],
    },
    run: { _tag: "Running", headSha: "cached-head", startedAt: "2026-10-26T00:00:00Z" },
  };
  const source = Atom.make(AsyncResult.success(initial));
  let acquisitions = 0;
  let releases = 0;
  const guide = Atom.make((get) => {
    acquisitions++;
    get.addFinalizer(() => {
      releases++;
    });
    return get(source);
  }).pipe(Atom.setIdleTTL("0 millis"));
  mocks.guide = guide;
  mocks.empty = Atom.make(AsyncResult.success(null));
  mocks.settings = Atom.make({ reviewGuidesEnabled: true });
  mocks.permission = Atom.make(true);
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    addListener: (event: keyof typeof listeners, listener: () => void) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  } as unknown as NavigationProp<ParamListBase>;
  const params = {
    environmentId: "environment",
    projectId: "project",
    repository: "repo",
    number: 1,
    initialSummary: {
      title: "Test PR",
      state: "open",
      isDraft: false,
      provider: "github",
      updatedAt: "2026-10-26T00:00:00Z",
      author: null,
      baseBranch: "main",
      headBranch: "change",
    } as PullRequestListEntry,
  };
  return {
    container,
    render(stop = false) {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NavigationContext.Provider value={navigation}>
              <PullRequestRouteScreen route={{ params }} />
              {stop ? (
                <PullRequestGuideStopScreen
                  route={{
                    params: {
                      ...params,
                      position: 0,
                      guideHeadSha: "cached-head",
                      guideGeneratedAt: "2026-10-26T00:00:00Z",
                    },
                  }}
                />
              ) : null}
            </NavigationContext.Provider>
          </RegistryContext.Provider>,
        ),
      );
    },
    select(label: string) {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      if (!button) throw new Error(`Missing section ${label}`);
      act(() => button.click());
    },
    complete() {
      act(() => registry.set(source, AsyncResult.success({ ...initial, run: null })));
    },
    focus(next: boolean) {
      focused = next;
      act(() => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
    get acquisitions() {
      return acquisitions;
    },
    get releases() {
      return releases;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      expect(releases).toBe(acquisitions);
      expect(listeners.focus.size).toBe(0);
      expect(listeners.blur.size).toBe(0);
    },
  };
}

it("retains the production Guide query and cached outline while hidden, then refreshes once on reveal", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  {
    using screen = setup();
    screen.render();
    screen.select("Guide");
    const outline = screen.container.querySelector("p");
    expect(outline?.textContent).toBe("Cached guide cached-head");
    expect(screen.container.textContent).toContain("Rewriting guide");
    screen.select("Overview");
    const beforeHidden = mocks.refresh.mock.calls.length;
    const acquisitions = screen.acquisitions;
    const releases = screen.releases;
    act(() => vi.advanceTimersByTime(60_000));
    expect({
      manualRefreshes: mocks.refresh.mock.calls.length - beforeHidden,
      queryAcquisitions: screen.acquisitions - acquisitions,
    }).toEqual({ manualRefreshes: 0, queryAcquisitions: 0 });
    expect(screen.releases).toBe(releases);
    expect(screen.container.querySelector("p")).toBe(outline);

    screen.complete();
    expect(screen.container.textContent).not.toContain("Rewriting guide");
    expect(mocks.refresh).toHaveBeenCalledTimes(beforeHidden);
    expect(screen.acquisitions).toBeGreaterThan(acquisitions);
    screen.select("Guide");
    expect(mocks.refresh).toHaveBeenCalledTimes(beforeHidden + 1);
    expect(screen.container.querySelector("p")).toBe(outline);
    act(() => vi.advanceTimersByTime(10_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(beforeHidden + 1);
  }
  // AtomRegistry defers node removal to its zero-delay dispatcher.
  act(() => vi.advanceTimersByTime(0));
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the standalone GuideStop reader refreshing while the retained pane is hidden", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  {
    using screen = setup();
    screen.render(true);
    const initial = mocks.refresh.mock.calls.length;
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(initial + 1);
    screen.focus(false);
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(initial + 1);
    screen.focus(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(initial + 2);
    screen.render(false);
    const afterStop = mocks.refresh.mock.calls.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(afterStop);
    expect(vi.getTimerCount()).toBe(0);
  }
  // AtomRegistry defers node removal to its zero-delay dispatcher.
  act(() => vi.advanceTimersByTime(0));
  expect(vi.getTimerCount()).toBe(0);
});
