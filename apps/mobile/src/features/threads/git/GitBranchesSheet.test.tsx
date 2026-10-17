import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  fields: [] as string[],
  fieldIndex: 0,
  canChangeThreadBranch: true,
  navigations: 0,
  result: Promise.resolve(null) as Promise<unknown>,
  platform: "ios",
  vcsKind: "git",
  unsupportedReason: undefined as string | undefined,
  mutations: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: string) => {
    const index = state.fieldIndex++;
    state.fields[index] ??= initial;
    return [state.fields[index], (value: string) => (state.fields[index] = value)];
  },
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => state.navigations++ }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: "SheetHeader" }));
vi.mock("../../../native/StackHeader", () => ({
  NativeStackScreenOptions: "NativeStackScreenOptions",
}));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({
  AndroidSheetHeader: "AndroidSheetHeader",
}));
vi.mock("../../../components/ui/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("./gitSheetComponents", () => ({ SheetActionButton: "SheetActionButton" }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      refName: "main",
      vcs: { kind: state.vcsKind, unsupportedReason: state.unsupportedReason },
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment", branch: "main" } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: state.canChangeThreadBranch,
    onCreateSelectedThreadBranch: () => {
      state.mutations++;
      return state.result;
    },
    onCreateSelectedThreadWorktree: () => {
      state.mutations++;
      return state.result;
    },
    onCheckoutSelectedThreadBranch: () => {
      state.mutations++;
      return state.result;
    },
  }),
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

type ControlProps = {
  label?: string;
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  onPress?: () => unknown;
  onChangeText?: (value: string) => void;
  value?: string;
  children?: ReactNode;
};

function findControl(node: ReactNode, label: string): ControlProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const control = findControl(child, label);
      if (control) return control;
    }
    return null;
  }
  if (!isValidElement<ControlProps>(node)) return null;
  if (
    node.props.label === label ||
    node.props.title === label ||
    node.props.placeholder === label ||
    (label === "checkout" && node.type === "Pressable")
  ) {
    return node.props;
  }
  return findControl(node.props.children, label);
}

function control(label: string) {
  state.fieldIndex = 0;
  const found = findControl(
    GitBranchesSheet({ route: { params: { environmentId: "environment", threadId: "thread" } } }),
    label,
  );
  if (!found) throw new Error(`Missing sheet control: ${label}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("branch sheet operation completion", () => {
  beforeEach(() => {
    state.fields = [];
    state.fieldIndex = 0;
    state.canChangeThreadBranch = true;
    state.navigations = 0;
    state.platform = "ios";
    state.vcsKind = "git";
    state.unsupportedReason = undefined;
    state.mutations = 0;
    control("feature/mobile-polish").onChangeText?.("feature/branch");
    control("main").onChangeText?.("release");
    control("feature/mobile-thread").onChangeText?.("feature/worktree");
  });

  it.each(["Create & switch", "Create workspace", "checkout"])(
    "disables and refuses unsupported %s without navigation",
    async (operation) => {
      state.vcsKind = "jj";
      state.unsupportedReason = "Install Jujutsu";
      const action = control(operation);
      expect(action.disabled).toBe(true);
      await action.onPress?.();
      expect(state.mutations).toBe(0);
      expect(state.navigations).toBe(0);
    },
  );
});

describe("branch sheet terminology", () => {
  it.each([
    ["git", "Branches & worktrees"],
    ["jj", "Bookmarks & workspaces"],
  ])("capitalizes the %s sheet title", (kind, title) => {
    state.platform = "android";
    state.vcsKind = kind;
    state.fields = [];
    expect(control(title).title).toBe(title);
  });
});
