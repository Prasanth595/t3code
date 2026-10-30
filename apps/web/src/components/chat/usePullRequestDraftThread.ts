import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { newDraftId, newThreadId } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildDraftThreadRouteParams } from "../../threadRoutes";
import {
  type DraftCheckoutPullRequest,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import { openPullRequestThreadDialog } from "./ChatOverlayHosts";
import { readThreadShell, untilThreadShell } from "../../state/entities";
import { checkoutLandedOnSentDraft } from "../ChatView.logic";
import { type EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
interface PullRequestDraftThreadInput {
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly settings: UnifiedSettings;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly activeProject: EnvironmentProject | null;
  readonly activeThreadKey: string | null;
  readonly isServerThread: boolean;
  readonly canCheckoutPullRequestIntoThread: boolean;
  readonly environmentId: EnvironmentId;
  readonly linkCheckoutPullRequest: (threadRef: ScopedThreadRef, url: string) => void;
  readonly sentDraftThreadIds: { readonly current: ReadonlySet<ThreadId> };
}

/**
 * Checking out a pull request into a thread: opens the dialog, then puts the prepared branch or
 * worktree on the project's draft thread, reusing the one already open when there is one.
 */
export function usePullRequestDraftThread(input: PullRequestDraftThreadInput) {
  const {
    routeKind,
    draftId,
    settings,
    projectGroupingSettings,
    activeProject,
    activeThreadKey,
    isServerThread,
    canCheckoutPullRequestIntoThread,
    environmentId,
    linkCheckoutPullRequest,
    sentDraftThreadIds,
  } = input;
  const navigate = useNavigate();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );

  const openPullRequestDialog = (reference?: string) => {
    if (!canCheckoutPullRequestIntoThread) {
      return;
    }
    if (activeThreadKey === null) return;
    openPullRequestThreadDialog(activeThreadKey, reference);
  };
  const openPullRequestDialogStable = useStableCallback(openPullRequestDialog);

  // The shell can arrive long after preparation (remote environments), so a checkout that
  // lands on a sent draft links once the shell exists, without a timeout.
  const [pendingShellLinks, setPendingShellLinks] = useState<
    ReadonlyMap<string, { readonly threadRef: ScopedThreadRef; readonly url: string }>
  >(new Map());
  const linkPendingShellStable = useStableCallback(
    (pending: { readonly threadRef: ScopedThreadRef; readonly url: string }) => {
      linkCheckoutPullRequest(pending.threadRef, pending.url);
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the thread-shell atom so each pending checkout link fires the moment the shell arrives
  useEffect(() => {
    if (pendingShellLinks.size === 0) return;
    const stops = Array.from(pendingShellLinks.entries()).map(([threadKey, pending]) =>
      untilThreadShell(pending.threadRef, () => {
        linkPendingShellStable(pending);
        setPendingShellLinks((current) => {
          const next = new Map(current);
          next.delete(threadKey);
          return next;
        });
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [pendingShellLinks, linkPendingShellStable]);

  const openOrReuseProjectDraftThread = async (input: {
    branch: string;
    worktreePath: string | null;
    envMode: DraftThreadEnvMode;
    checkoutPullRequest: DraftCheckoutPullRequest;
  }) => {
    if (!activeProject) {
      throw new Error("No active project is available for this pull request.");
    }
    const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
    const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
      activeProject,
      projectGroupingSettings,
    );
    const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    if (storedDraftSession) {
      setDraftThreadContext(storedDraftSession.draftId, input);
      setLogicalProjectDraftThreadId(
        logicalProjectKey,
        activeProjectRef,
        storedDraftSession.draftId,
        {
          threadId: storedDraftSession.threadId,
          ...input,
        },
      );
      if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
        await navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(storedDraftSession.draftId),
        });
      }
      return storedDraftSession.threadId;
    }

    const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
    if (!isServerThread && activeDraftSession?.logicalProjectKey === logicalProjectKey && draftId) {
      setDraftThreadContext(draftId, input);
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
        threadId: activeDraftSession.threadId,
        createdAt: activeDraftSession.createdAt,
        runtimeMode: activeDraftSession.runtimeMode,
        interactionMode: activeDraftSession.interactionMode,
        ...input,
      });
      return activeDraftSession.threadId;
    }

    const nextDraftId = newDraftId();
    const nextThreadId = newThreadId();
    setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
      threadId: nextThreadId,
      createdAt: new Date().toISOString(),
      runtimeMode: resolveProjectSettings(settings, activeProject.id, activeProject).settings
        .defaultRuntimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      ...input,
    });
    await navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(nextDraftId),
    });
    return nextThreadId;
  };

  const handlePreparedPullRequestThread = async (input: {
    branch: string;
    worktreePath: string | null;
    pullRequestUrl: string;
  }) => {
    const threadId = await openOrReuseProjectDraftThread({
      branch: input.branch,
      worktreePath: input.worktreePath,
      envMode: input.worktreePath ? "worktree" : "local",
      checkoutPullRequest: { url: input.pullRequestUrl, branch: input.branch },
    });
    // The draft holds the pull request until its first send creates the thread. A draft sent
    // while the checkout ran missed it, so its thread is linked here once it exists.
    const threadRef = scopeThreadRef(environmentId, threadId);
    if (
      !checkoutLandedOnSentDraft({
        threadId,
        sentDraftThreadIds: sentDraftThreadIds.current,
        draft: useComposerDraftStore.getState().getDraftSessionByRef(threadRef),
        threadShellExists: readThreadShell(threadRef) !== null,
      })
    ) {
      return;
    }
    // A send that fails never creates the thread; the draft keeps the pull request and its
    // next send links it.
    setPendingShellLinks((current) => {
      const next = new Map(current);
      next.set(scopedThreadKey(threadRef), { threadRef, url: input.pullRequestUrl });
      return next;
    });
  };
  const handlePreparedPullRequestThreadStable = useStableCallback(handlePreparedPullRequestThread);
  return {
    handlePreparedPullRequestThreadStable,
    openPullRequestDialogStable,
  };
}
