import { useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { nativePullRequestDestination } from "../lib/pullRequestNavigation";
import { useCallback } from "react";
import { Platform } from "react-native";
import { useSelectWorkspaceDetail } from "../features/workspace/useSelectWorkspaceDetail";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../state/entities";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentServerConfigsAtom } from "../state/server";

type PullRequestContext = { readonly environmentId: string; readonly projectId: string };

// Avoid useRoute so layouts without route context can open any thread's pull requests.
export function useNavigateToPullRequest(options?: {
  readonly replace?: boolean;
  readonly drillIn?: boolean;
}) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const replace = options?.replace;
  const drillIn = options?.drillIn;
  return useCallback(
    async (url: string, context: PullRequestContext | null) => {
      // Read at press time so a capability push does not hand every link a new handler.
      const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
      const params = nativePullRequestDestination(
        url,
        context,
        projects,
        (environmentId) => serverConfigs.get(environmentId)?.environment.capabilities,
      );
      if (!params) return tryOpenExternalUrl(url, "pull-request");
      if (Platform.OS === "android" && !drillIn) {
        selectDetail({ name: "PullRequest", params });
        return true;
      }
      if (replace) navigation.dispatch(StackActions.replace("PullRequest", params));
      else navigation.dispatch(StackActions.push("PullRequest", params));
      return true;
    },
    [drillIn, navigation, projects, replace, selectDetail],
  );
}

export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly drillIn?: boolean;
  readonly context?: PullRequestContext;
}) {
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const thread = useThreadShell(
    environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const navigateToPullRequest = useNavigateToPullRequest(options);
  return useCallback(
    (url: string) =>
      navigateToPullRequest(
        url,
        environmentId && projectId
          ? { environmentId: String(environmentId), projectId: String(projectId) }
          : null,
      ),
    [environmentId, projectId, navigateToPullRequest],
  );
}
