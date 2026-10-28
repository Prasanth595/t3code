import { isWorkspaceOverlayRoute } from "../layout/workspace-overlay-routes";

export type NewTaskDraftRouteParams = {
  readonly requestId?: string;
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly title?: string | string[];
  readonly cloning?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function isDraftThreadRoute(
  route:
    | {
        readonly name: string;
        readonly params?: object;
      }
    | undefined,
): route is {
  readonly key?: string;
  readonly name: string;
  readonly params: { readonly draft: NewTaskDraftRouteParams };
} {
  return (
    route?.name === "Thread" && Boolean((route.params as { draft?: unknown } | undefined)?.draft)
  );
}

export function submittedThreadParams(environmentId: string, threadId: string) {
  return { draft: undefined, environmentId, threadId };
}

export function draftRouteIdentity(draft: NewTaskDraftRouteParams): string {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return JSON.stringify([
    draft.requestId,
    first(draft.draftId),
    first(draft.environmentId),
    first(draft.projectId),
    draft.branch ?? null,
    draft.worktreePath ?? null,
    first(draft.incomingShareId),
  ]);
}

export type ThreadNavigationState = {
  readonly index: number;
  readonly routes: ReadonlyArray<{
    readonly key?: string;
    readonly name: string;
    readonly params?: object;
  }>;
};

export function selectedChatRoute(state: ThreadNavigationState | undefined, _platform = "ios") {
  if (!state) return undefined;
  for (let index = state.index; index >= 0; index -= 1) {
    const route = state.routes[index];
    if (!route) return undefined;
    if (route.name === "Thread") return route;
    if (
      !isWorkspaceOverlayRoute(route.name) &&
      !route.name.startsWith("Thread") &&
      !route.name.startsWith("NewTask") &&
      ![
        "SettingsLegal",
        "EnvironmentSheet",
        "AgentDetails",
        "GitBranches",
        "GitCommit",
        "GitConfirm",
        "GitOverview",
      ].includes(route.name)
    )
      return undefined;
  }
  return undefined;
}

export function openThreadView(
  state: ThreadNavigationState | undefined,
  platform = "ios",
): { readonly environmentId: string; readonly threadId: string } | null {
  const params = selectedChatRoute(state, platform)?.params as
    | { environmentId?: string; threadId?: string; draft?: unknown }
    | undefined;
  return !params?.draft &&
    typeof params?.environmentId === "string" &&
    typeof params.threadId === "string"
    ? { environmentId: params.environmentId, threadId: params.threadId }
    : null;
}

export function hasOpenThreadDraft(state: ThreadNavigationState, platform = "ios"): boolean {
  return isDraftThreadRoute(selectedChatRoute(state, platform));
}
