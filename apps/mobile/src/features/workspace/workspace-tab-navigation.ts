import type { WorkspaceSelections } from "../../persistence/mobile-preferences";
import { isSettingsRoute, settingsNavigationState } from "../settings/settings-navigation";
import type { WorkspaceTab } from "./workspace-tabs-state";

type RouteLike = { readonly name: string; readonly params?: object | undefined };

/** Opened when Settings has columns and none of its pages has been opened yet. */
export const DEFAULT_SETTINGS_PAGE = "SettingsEnvironments";

function stringParam(params: object | undefined, key: string) {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The page each tab shows in a root route chain: the newest chat, the newest pull request, and
 * the Settings page directly above the Settings route. Returns `previous` when nothing changed.
 */
export function workspaceSelectionsIn(
  routes: readonly RouteLike[],
  previous: WorkspaceSelections,
): WorkspaceSelections {
  let next = previous;
  const thread = routes.findLast((route) => route.name === "Thread");
  const environmentId = stringParam(thread?.params, "environmentId");
  const threadId = stringParam(thread?.params, "threadId");
  if (
    environmentId &&
    threadId &&
    (next.threads?.environmentId !== environmentId || next.threads.threadId !== threadId)
  ) {
    next = { ...next, threads: { environmentId, threadId } };
  }
  const pullRequest = routes.findLast((route) => route.name === "PullRequest")?.params as
    | Record<string, unknown>
    | undefined;
  if (
    pullRequest &&
    typeof pullRequest.environmentId === "string" &&
    typeof pullRequest.projectId === "string" &&
    typeof pullRequest.repository === "string" &&
    typeof pullRequest.number === "number"
  ) {
    const selection = {
      environmentId: pullRequest.environmentId,
      projectId: pullRequest.projectId,
      repository: pullRequest.repository,
      number: pullRequest.number,
      ...(typeof pullRequest.host === "string" ? { host: pullRequest.host } : {}),
    };
    const current = next.pullRequests;
    if (
      current?.environmentId !== selection.environmentId ||
      current.projectId !== selection.projectId ||
      current.repository !== selection.repository ||
      current.number !== selection.number ||
      current.host !== selection.host
    ) {
      next = { ...next, pullRequests: selection };
    }
  }
  const list = routes.findIndex((route) => route.name === "Settings");
  const page = list < 0 ? undefined : routes[list + 1];
  // Pages that need params, such as one environment's detail, are reached from another page.
  if (
    page &&
    isSettingsRoute(page.name) &&
    page.params === undefined &&
    page.name !== next.settings
  ) {
    next = { ...next, settings: page.name };
  }
  return next;
}

/**
 * The root stack for opening a workspace tab. With columns the detail column must show
 * something, so the tab reopens the page it last showed (Settings falls back to its default);
 * without columns the tab opens on its list.
 */
export function workspaceTabNavigationState<
  State extends { readonly routes: readonly { readonly name: string }[] },
>(state: State, tab: WorkspaceTab | "settings", selections: WorkspaceSelections, columns: boolean) {
  if (tab === "settings") {
    const page = columns ? (selections.settings ?? DEFAULT_SETTINGS_PAGE) : "Settings";
    return settingsNavigationState(state, page as Parameters<typeof settingsNavigationState>[1]);
  }
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  const detail =
    !columns || tab === "usage"
      ? undefined
      : tab === "threads"
        ? selections.threads && { name: "Thread", params: selections.threads }
        : selections.pullRequests && { name: "PullRequest", params: selections.pullRequests };
  const routes = detail ? [home, detail] : [home];
  return { ...state, index: routes.length - 1, routes };
}
