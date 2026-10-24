/**
 * Root routes presented over the workspace (sheets and modals). Everything else is part of the
 * workspace: its list, or a page in the detail column.
 */
export const WORKSPACE_OVERLAY_ROUTES: ReadonlySet<string> = new Set([
  "PullRequestReview",
  "PullRequestInlineComment",
  "ConnectOnboarding",
  "Connections",
  "ConnectionsNew",
  "GitBranches",
  "GitCommit",
  "GitConfirm",
  "GitOverview",
  "NewTaskProject",
  "NewTaskFiles",
  "NewTaskFile",
  "NewTaskAttachment",
  "NewTaskThreadSettings",
  "AddProject",
  "AddProjectRepository",
  "AddProjectDestination",
  "AddProjectLocal",
  "AddProjectNew",
  "NewTaskEnvironment",
  "NewTaskBranch",
  "SettingsLegal",
  "SettingsAuth",
  "SettingsWaitlist",
  "ThreadAgents",
  "ThreadBackgroundWork",
  "ThreadPullRequests",
  "ThreadQueue",
  "ThreadReviewComment",
  "ThreadDevicePreview",
  "ThreadBrowserPreview",
  "ThreadSettingsSheet",
]);

/** The routes that make up the workspace, up to the first sheet or modal above it. */
export function workspaceRoutesOf<Route extends { readonly name: string }>(
  routes: readonly Route[],
) {
  const firstOverlay = routes.findIndex((route) => WORKSPACE_OVERLAY_ROUTES.has(route.name));
  return {
    workspace: firstOverlay < 0 ? routes : routes.slice(0, firstOverlay),
    overlays: firstOverlay < 0 ? [] : routes.slice(firstOverlay),
  };
}
