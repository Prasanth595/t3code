import { submittedThreadParams } from "./thread-route-state";
import { NativeScrollEdgeEffectsContext } from "../../native/NativeScrollViewMarker";
import { ThreadScreenBinding, ThreadScreenFallback } from "./ThreadScreenHost";
import { draftThreadShell } from "./draft-thread-shell";
import { connectionTone } from "../connection/connectionTone";
import { AppBar } from "../../components/ui/AppBar";
import { ThreadId } from "@t3tools/contracts";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";

import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  nextPastedTextFileName,
  pastedTextDisposition,
  replaceTextSelection,
} from "@t3tools/client-runtime/text-paste";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  CommonActions,
  StackActions,
  useNavigation,
  usePreventRemove,
} from "@react-navigation/native";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { KeyboardController } from "react-native-keyboard-controller";

import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";

import { type ComposerEditorHandle, type ComposerTextPaste } from "../../components/ComposerEditor";
import { composerContextImportsAtom } from "../../state/use-composer-drafts";
import { composerContextSendBlockReason } from "../../lib/composerContext";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { hasProviderUsageLimits, isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "../../lib/composerImages";

import {
  clearComposerDraftContent,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  restoreComposerDraftSnapshot,
  updateComposerDraftSettings,
  scheduleUnusedComposerAttachmentCleanup,
  type ComposerDraft,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useProjectClone } from "../../state/projectClones";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectCloneBanner } from "./ProjectCloneBanner";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  nextEnvironmentId,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import { resolveDraftProjectSelection } from "./new-task-project-selection";
import {
  resolveNewTaskBranchLabel,
  resolveNewTaskWorkspaceLabel,
  resolveNewTaskWorkspaceSelection,
} from "./new-task-context-presentation";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { selectIncomingShareAttachmentsForServer } from "../sharing/incoming-share-model";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";

function NewTaskWorkspaceIcon(props: {
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly size: number;
}) {
  if (props.workspaceMode === "local" && props.worktreePath === null) {
    return (
      <SymbolView
        name="folder"
        size={props.size}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    );
  }

  const boxSize = (14 * props.size) / 16;
  return (
    <View
      className="size-4"
      style={Platform.OS === "android" ? { width: boxSize, height: boxSize } : undefined}
    >
      <SymbolView
        name="folder"
        size={props.size}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <View
        className="absolute -right-1 -bottom-1"
        style={
          Platform.OS === "android" ? { right: -boxSize / 4, bottom: -boxSize / 4 } : undefined
        }
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={Math.round((9 * props.size) / 16)}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
    </View>
  );
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly cloning?: boolean;
  };
  readonly pendingTaskId?: string;
  readonly draftId?: string;
  readonly incomingShareId?: string;
}) {
  const [creationMetadata] = useState(makeTurnCommandMetadata);
  const projects = useProjects();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const {
    consumeShare,
    getShare,
    isLoading: isIncomingShareInboxLoading,
    releaseShareReservation,
    reserveShare,
  } = useIncomingShare();
  const { projectScopes, selectedProject, selectedProjectKey, setProject } = flow;
  const selectedProjectLabel = (() => {
    if (!selectedProject) return null;
    const scope = projectScopes.find((candidate) =>
      candidate.projectRefs.some(
        (ref) =>
          ref.environmentId === selectedProject.environmentId &&
          ref.projectId === selectedProject.id,
      ),
    );
    return scope?.title ?? selectedProject.title;
  })();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const environmentConnected =
    selectedProject !== null &&
    connectedEnvironments.find(
      (environment) => environment.environmentId === selectedProject.environmentId,
    )?.connectionState === "connected";
  const canOperate = useEnvironmentScope(
    selectedProject?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const taskPermissionReason =
    environmentConnected && !canOperate ? "This connection cannot start tasks." : null;
  const modelUnavailable = environmentConnected && flow.selectedModelOption?.isUnavailable === true;
  const projectCloneState = useProjectClone(
    selectedProject
      ? { environmentId: selectedProject.environmentId, projectId: selectedProject.id }
      : null,
  );
  const projectClone = projectCloneState === "pending" ? null : projectCloneState;
  const awaitingKnownClone =
    projectCloneState === "pending" &&
    props.initialProjectRef?.cloning === true &&
    selectedProject !== null &&
    selectedProject.id === props.initialProjectRef.projectId &&
    selectedProject.environmentId === props.initialProjectRef.environmentId;
  const cloneBlocksStart =
    awaitingKnownClone || (projectClone !== null && projectClone.phase !== "done");
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const runCloneAction = async (
    title: string,
    action: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => {
    const result = await action();
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      Dialog.alert(title, error instanceof Error ? error.message : "An error occurred.");
    }
  };
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const selectedProjectRef = useRef(selectedProject);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);
  const removeClonedProject = async () => {
    if (!selectedProject) return;
    const removed = selectedProject;
    const result = await deleteProject({
      environmentId: removed.environmentId,
      input: { projectId: removed.id },
    });
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Failed to remove project",
        error instanceof Error ? error.message : "An error occurred.",
      );
      return;
    }
    const current = selectedProjectRef.current;
    if (current?.id === removed.id && current.environmentId === removed.environmentId) {
      navigation.dispatch(StackActions.replace("Home"));
    }
  };
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentBlockReason = selectedProject
    ? composerAttachmentUploadBlockReason({
        environmentId: selectedProject.environmentId,
        attachments: flow.attachments,
        connected: environmentConnected,
        serverConfig: selectedEnvironmentServerConfig,
        states: uploadStates,
      })
    : null;
  const attachmentsUploading =
    environmentConnected &&
    selectedProject !== null &&
    composerAttachmentsStillUploading({
      environmentId: selectedProject.environmentId,
      attachments: flow.attachments,
      serverConfig: selectedEnvironmentServerConfig,
      states: uploadStates,
    });
  const queuesInsteadOfStarting = !environmentConnected || attachmentsUploading;
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const [importingShareKey, setImportingShareKey] = useState<string | null>(null);
  const [isCancellingShareImport, setIsCancellingShareImport] = useState(false);
  const [cancelledIncomingShareId, setCancelledIncomingShareId] = useState<string | null>(null);
  const [isReturningToProjectPicker, setIsReturningToProjectPicker] = useState(false);
  const [shareImportAttempt, setShareImportAttempt] = useState(0);
  const startedShareImportKeyRef = useRef<string | null>(null);
  const cancellingShareImportKeyRef = useRef<string | null>(null);
  const shareImportDraftBackupRef = useRef(new Map<string, ComposerDraft>());
  const activeShareImportTokenRef = useRef<symbol | null>(null);
  const shareImportMountedRef = useRef(true);
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const pastedTextFileNamesRef = useRef<{ draftKey: string | null; names: Set<string> }>({
    draftKey: null,
    names: new Set(),
  });
  // The share import resumes after awaits; this reads the screen's current
  // draft and share at that point without re-running the import effect.
  const isCurrentShareImport = useEffectEvent(
    (draftKey: string, shareId: string) =>
      flow.draftKey === draftKey && props.incomingShareId === shareId,
  );
  // Pasted-text attachments finish in an event handler, where an effect event
  // cannot be called and the provider's draft key has no store to read.
  const latestDraftKeyRef = useRef(flow.draftKey);
  useLayoutEffect(() => {
    latestDraftKeyRef.current = flow.draftKey;
  });
  const isImportingShare = importingShareKey !== null;
  const alertedUnavailableIncomingShareIdRef = useRef<string | null>(null);
  // The share this screen already moved into its draft. Sending clears the
  // draft (and its importedShareIds receipt) a frame before the screen leaves,
  // and the inbox entry is long gone by then; without this the re-render in
  // between reads as "shared content vanished" and alerts on every send.
  const [consumedIncomingShareId, setConsumedIncomingShareId] = useState<string | null>(null);
  const incomingShare = props.incomingShareId ? getShare(props.incomingShareId) : null;
  const requestedInitialProjectAvailable = Boolean(
    props.initialProjectRef?.environmentId &&
    props.initialProjectRef.projectId &&
    projects.some(
      (project) =>
        project.environmentId === props.initialProjectRef?.environmentId &&
        project.id === props.initialProjectRef?.projectId,
    ),
  );
  const isProjectPickerReturnActive =
    isReturningToProjectPicker && !requestedInitialProjectAvailable;
  const isIncomingShareAwaitingServerConfig = Boolean(
    incomingShare?.attachments.some((attachment) => attachment.type === "file") &&
    selectedEnvironmentServerConfig === null,
  );
  const isIncomingShareTransferPending = Boolean(
    incomingShare &&
    cancelledIncomingShareId !== props.incomingShareId &&
    !isIncomingShareAwaitingServerConfig,
  );
  const contextImports = useAtomValue(composerContextImportsAtom);
  const isImportingContext = flow.draftKey ? contextImports[flow.draftKey] === true : false;
  const isComposerInteractionLocked =
    isIncomingShareTransferPending || flow.submitting || isImportingContext;
  const { environments, selectedEnvironmentId, switchEnvironment, switchingToEnvironmentId } = flow;
  const cycleEnvironment = () => {
    if (isComposerInteractionLocked) return true;
    const next = nextEnvironmentId(environments, switchingToEnvironmentId ?? selectedEnvironmentId);
    if (next !== null) void switchEnvironment(next);
    return true;
  };
  const cycleEnvironmentCommands = environments.length > 1 ? (["cycleHost"] as const) : [];
  useHardwareKeyboardCommand(cycleEnvironmentCommands, cycleEnvironment);
  const offersUsageLimits =
    flow.selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      flow.selectedProviderStatus.driver,
      selectedEnvironmentServerConfig?.providers ?? [],
      selectedEnvironmentServerConfig?.usageLimitSources ?? [],
    );
  const composerWorkspaceCwd =
    (flow.workspaceMode === "worktree"
      ? selectedProject?.workspaceRoot
      : (flow.selectedWorktreePath ?? selectedProject?.workspaceRoot)) || null;
  const preventRemove =
    (isIncomingShareTransferPending && !isProjectPickerReturnActive) ||
    isCancellingShareImport ||
    flow.submitting;
  usePreventRemove(preventRemove, () => undefined);
  const hasImportedIncomingShare = Boolean(
    props.incomingShareId &&
    (consumedIncomingShareId === props.incomingShareId ||
      (flow.draftKey &&
        getComposerDraftSnapshot(flow.draftKey).importedShareIds?.includes(props.incomingShareId))),
  );
  const isIncomingShareUnavailable = Boolean(
    props.incomingShareId &&
    !isIncomingShareInboxLoading &&
    !incomingShare &&
    !hasImportedIncomingShare,
  );
  const isIncomingShareReady =
    !props.incomingShareId ||
    (hasImportedIncomingShare && !incomingShare) ||
    isIncomingShareUnavailable;
  const appliedInitialProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (cancelledIncomingShareId === props.incomingShareId) {
      navigation.goBack();
    }
  }, [cancelledIncomingShareId, navigation, props.incomingShareId]);
  useEffect(() => {
    if (!isReturningToProjectPicker) {
      return;
    }
    if (requestedInitialProjectAvailable) {
      setIsReturningToProjectPicker(false);
      return;
    }
    // Let usePreventRemove commit its disabled state before replacing this
    // route, otherwise the transfer guard can swallow the fallback action.
    const frame = requestAnimationFrame(() => {
      navigation.dispatch(
        CommonActions.navigate("NewTaskSheet", {
          screen: "NewTask",
          params: { incomingShareId: props.incomingShareId },
        }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    isReturningToProjectPicker,
    navigation,
    props.incomingShareId,
    requestedInitialProjectAvailable,
  ]);
  useEffect(() => {
    if (!shareImportMountedRef.current) {
      startedShareImportKeyRef.current = null;
    }
    shareImportMountedRef.current = true;
    return () => {
      appliedInitialProjectKeyRef.current = null;
      shareImportMountedRef.current = false;
      activeShareImportTokenRef.current = null;
      cancellingShareImportKeyRef.current = null;
    };
  }, []);

  const { beginEditingPendingTask, cancelEditingPendingTask, editingPendingTask, openDraft } = flow;
  // Drafts hydrate from disk and projects arrive with the shell snapshot, so on
  // a cold launch the draft or its project can be missing for a moment; wait
  // for hydration and retry while projects load.
  const attemptedDraftIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.draftId || props.pendingTaskId) {
      return;
    }
    const draftId = props.draftId;
    if (attemptedDraftIdRef.current === draftId) {
      return;
    }
    let cancelled = false;
    void waitForComposerDraftsLoaded().then(() => {
      if (cancelled || attemptedDraftIdRef.current === draftId) {
        return;
      }
      if (openDraft(draftId)) {
        attemptedDraftIdRef.current = draftId;
        return;
      }
      if (getComposerDraftSnapshot(draftId).project !== undefined && projects.length === 0) {
        return;
      }
      attemptedDraftIdRef.current = draftId;
      navigation.dispatch(CommonActions.navigate("NewTaskSheet", { screen: "NewTask" }));
    });
    return () => {
      cancelled = true;
    };
  }, [navigation, openDraft, projects, props.draftId, props.pendingTaskId]);

  const attemptedPendingTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.pendingTaskId || editingPendingTask?.messageId === props.pendingTaskId) {
      return;
    }
    if (attemptedPendingTaskIdRef.current === props.pendingTaskId) {
      return;
    }
    attemptedPendingTaskIdRef.current = props.pendingTaskId;
    if (!beginEditingPendingTask(props.pendingTaskId)) {
      navigation.dispatch(CommonActions.navigate("NewTaskSheet", { screen: "NewTask" }));
    }
  }, [beginEditingPendingTask, editingPendingTask?.messageId, navigation, props.pendingTaskId]);

  useEffect(() => {
    if (!props.pendingTaskId) return;
    return () => {
      attemptedPendingTaskIdRef.current = null;
      cancelEditingPendingTask();
    };
  }, [props.pendingTaskId, cancelEditingPendingTask]);

  const lastInitialProjectRefRef = useRef(props.initialProjectRef);

  useEffect(() => {
    if (props.pendingTaskId || props.draftId) {
      return;
    }
    if (lastInitialProjectRefRef.current !== props.initialProjectRef) {
      lastInitialProjectRefRef.current = props.initialProjectRef;
      appliedInitialProjectKeyRef.current = null;
    }
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    if (initialEnvironmentId && initialProjectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === initialEnvironmentId && project.id === initialProjectId,
        ) ?? null;

      if (directProject) {
        // Apply the route's project once. Re-applying on every change would
        // instantly revert environment/project switches made in the picker.
        const directProjectKey = `${directProject.environmentId}:${directProject.id}`;
        if (appliedInitialProjectKeyRef.current === directProjectKey) {
          return;
        }
        if (props.initialProjectRef?.branch) {
          if (
            selectedProject?.environmentId !== directProject.environmentId ||
            selectedProject.id !== directProject.id
          ) {
            setProject(directProject);
            return;
          }
          if (!flow.draftKey) return;
          // The route completes checkout before mounting this composer. Local
          // mode reuses an existing worktree; worktree mode would create another.
          updateComposerDraftSettings(flow.draftKey, {
            workspaceSelection: {
              mode: "local",
              branch: props.initialProjectRef.branch,
              worktreePath: props.initialProjectRef.worktreePath ?? null,
              startFromOrigin: false,
            },
          });
        }
        appliedInitialProjectKeyRef.current = directProjectKey;
        if (
          selectedProject?.environmentId === directProject.environmentId &&
          selectedProject.id === directProject.id
        ) {
          return;
        }
        setProject(directProject);
        return;
      }

      if (projects.length > 0) {
        setIsReturningToProjectPicker(true);
      }
      return;
    }

    const selection = resolveDraftProjectSelection(selectedProjectKey, projects, projectScopes);
    if (selection.kind === "preserve") {
      return;
    }
    if (selection.kind === "select") {
      setProject(selection.project);
      return;
    }

    navigation.dispatch(CommonActions.navigate("NewTaskSheet", { screen: "NewTask" }));
  }, [
    projectScopes,
    projects,
    flow.draftKey,
    props.initialProjectRef,
    props.incomingShareId,
    props.pendingTaskId,
    props.draftId,
    navigation,
    selectedProject,
    selectedProjectKey,
    setProject,
  ]);

  useEffect(() => {
    if (!selectedProject) {
      loadedBranchesProjectKeyRef.current = null;
      return;
    }
    const projectKey = `${selectedProject.environmentId}:${selectedProject.id}`;
    if (loadedBranchesProjectKeyRef.current === projectKey) {
      return;
    }
    loadedBranchesProjectKeyRef.current = projectKey;
    flow.loadBranches();
  }, [flow.loadBranches, selectedProject]);

  useEffect(() => {
    const shareId = props.incomingShareId;
    const draftKey = flow.draftKey;
    const destinationProject = selectedProject;
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    const selectedProjectMatchesRoute =
      !initialEnvironmentId ||
      !initialProjectId ||
      (destinationProject?.environmentId === initialEnvironmentId &&
        destinationProject.id === initialProjectId);
    if (
      !shareId ||
      !draftKey ||
      !destinationProject ||
      !selectedProjectMatchesRoute ||
      cancelledIncomingShareId === shareId
    ) {
      return;
    }
    const importKey = `${shareId}:${draftKey}`;
    if (
      startedShareImportKeyRef.current === importKey ||
      cancellingShareImportKeyRef.current === importKey
    ) {
      return;
    }

    if (!incomingShare) {
      if (isIncomingShareUnavailable && alertedUnavailableIncomingShareIdRef.current !== shareId) {
        alertedUnavailableIncomingShareIdRef.current = shareId;
        Dialog.alert(
          "Shared content unavailable",
          "The shared content is no longer in the inbox. You can continue editing this task draft.",
        );
      }
      return;
    }

    if (
      incomingShare.attachments.some((attachment) => attachment.type === "file") &&
      selectedEnvironmentServerConfig === null
    ) {
      return;
    }

    if (alertedUnavailableIncomingShareIdRef.current === shareId) {
      alertedUnavailableIncomingShareIdRef.current = null;
    }
    startedShareImportKeyRef.current = importKey;
    const draftBackup =
      shareImportDraftBackupRef.current.get(importKey) ?? getComposerDraftSnapshot(draftKey);
    shareImportDraftBackupRef.current.set(importKey, draftBackup);
    const importToken = Symbol(importKey);
    let didReserveShare = false;
    let didConsumeShare = false;
    let needsDraftRestore = false;
    activeShareImportTokenRef.current = importToken;
    setImportingShareKey(importKey);
    void (async () => {
      await reserveShare(shareId, {
        environmentId: String(destinationProject.environmentId),
        projectId: String(destinationProject.id),
      });
      didReserveShare = true;
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        !isCurrentShareImport(draftKey, shareId)
      ) {
        return;
      }
      const selectedAttachments = selectIncomingShareAttachmentsForServer({
        attachments: incomingShare.attachments,
        serverConfig: appAtomRegistry.get(
          serverEnvironment.configValueAtom(destinationProject.environmentId),
        ),
      });
      if (selectedAttachments.status === "pending") {
        throw new Error("Server attachment support is still loading.");
      }
      needsDraftRestore = true;
      const { skippedAttachmentCount } = await mergeComposerDraftContent(draftKey, {
        text: incomingShare.text,
        attachments: selectedAttachments.attachments,
        sourceShareId: shareId,
      });
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        !isCurrentShareImport(draftKey, shareId)
      ) {
        // The durable reservation makes an interrupted transfer resume only
        // in this project instead of copying into a second project draft.
        return;
      }
      await consumeShare(shareId);
      didConsumeShare = true;
      setConsumedIncomingShareId(shareId);
      // The consumed inbox draft was the last owner of files that never made
      // it into the composer draft (unsupported server, oversize, limit
      // skips). Release them before any early return: an unmount or a
      // superseding import must not leak them, and the sweep re-checks
      // ownership so it cannot delete a file another draft picked up.
      const retainedAttachmentIds = new Set(
        getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
      );
      scheduleUnusedComposerAttachmentCleanup(
        incomingShare.attachments.filter((attachment) => !retainedAttachmentIds.has(attachment.id)),
      );
      if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
        return;
      }
      const warnings = [...incomingShare.warnings, ...selectedAttachments.warnings];
      if (skippedAttachmentCount > 0) {
        warnings.push(
          `${skippedAttachmentCount} shared file${skippedAttachmentCount === 1 ? " was" : "s were"} skipped because this draft reached the attachment limit.`,
        );
      }
      if (warnings.length > 0) {
        Dialog.alert("Some shared content was skipped", warnings.join("\n"));
      }
      shareImportDraftBackupRef.current.delete(importKey);
    })()
      .catch((error) => {
        if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
          return;
        }
        Dialog.alert(
          "Could not import shared content",
          error instanceof Error ? error.message : "The shared content could not be saved.",
          [
            {
              text: "Cancel import",
              style: "cancel",
              onPress: () => {
                const cancelImport = async (): Promise<void> => {
                  if (!shareImportMountedRef.current) {
                    return;
                  }
                  // Latch synchronously before restoring the draft. The
                  // restore publishes atom state and can re-run the import
                  // effect before React commits the cancelling state update.
                  cancellingShareImportKeyRef.current = importKey;
                  setIsCancellingShareImport(true);
                  try {
                    if (needsDraftRestore) {
                      // The restore drops the share's merged-in attachments
                      // from the draft. Sweep them only when the inbox entry
                      // was consumed: before that, the inbox still references
                      // these files and must keep them for a later import.
                      const mergedAttachments = getComposerDraftSnapshot(draftKey).attachments;
                      await restoreComposerDraftSnapshot(draftKey, draftBackup);
                      needsDraftRestore = false;
                      if (didConsumeShare) {
                        scheduleUnusedComposerAttachmentCleanup(mergedAttachments);
                      }
                    }
                    if (didReserveShare) {
                      await releaseShareReservation(shareId, {
                        environmentId: String(destinationProject.environmentId),
                        projectId: String(destinationProject.id),
                      });
                    }
                    shareImportDraftBackupRef.current.delete(importKey);
                    if (shareImportMountedRef.current) {
                      setIsCancellingShareImport(false);
                      setCancelledIncomingShareId(shareId);
                    }
                  } catch (cancelError) {
                    if (!shareImportMountedRef.current) {
                      return;
                    }
                    Dialog.alert(
                      "Could not cancel import",
                      cancelError instanceof Error
                        ? cancelError.message
                        : "The shared content could not be restored safely.",
                      [
                        {
                          text: "Retry import",
                          onPress: () => {
                            cancellingShareImportKeyRef.current = null;
                            setIsCancellingShareImport(false);
                            setShareImportAttempt((attempt) => attempt + 1);
                          },
                        },
                        {
                          text: "Retry cancel",
                          onPress: () => void cancelImport(),
                        },
                      ],
                      { cancelable: false },
                    );
                  }
                };
                void cancelImport();
              },
            },
            {
              text: "Retry",
              onPress: () => setShareImportAttempt((attempt) => attempt + 1),
            },
          ],
          { cancelable: false },
        );
      })
      .finally(() => {
        if (startedShareImportKeyRef.current === importKey) {
          startedShareImportKeyRef.current = null;
        }
        if (shareImportMountedRef.current && activeShareImportTokenRef.current === importToken) {
          activeShareImportTokenRef.current = null;
          setImportingShareKey(null);
        }
      });
  }, [
    consumeShare,
    cancelledIncomingShareId,
    flow.draftKey,
    hasImportedIncomingShare,
    incomingShare,
    isIncomingShareInboxLoading,
    isIncomingShareUnavailable,
    props.incomingShareId,
    props.initialProjectRef?.environmentId,
    props.initialProjectRef?.projectId,
    releaseShareReservation,
    reserveShare,
    selectedEnvironmentServerConfig,
    selectedProject,
    shareImportAttempt,
  ]);

  const selectedEnvironmentLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ?? "Environment";
  const availableCurrentBranchName =
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const selectedBranchName = resolveProjectThreadCreationBranch({
    workspaceMode: flow.workspaceMode,
    selectedBranch:
      flow.selectedBranchName ??
      (flow.workspaceMode === "worktree" ? availableCurrentBranchName : null),
    currentCheckoutBranch: flow.currentCheckoutBranchName,
  });
  const selectedBranchLabel = resolveNewTaskBranchLabel({
    branchName: selectedBranchName,
    startFromOrigin: flow.startFromOrigin,
    workspaceMode: flow.workspaceMode,
    pullRequestReference: flow.pullRequestReference,
  });
  const workspaceLabel = resolveNewTaskWorkspaceLabel({
    workspaceMode: flow.workspaceMode,
    worktreePath: flow.selectedWorktreePath,
  });
  const showBranchLoading = flow.branchesLoading && flow.availableBranches.length === 0;

  async function handlePickMedia(): Promise<void> {
    if (isComposerInteractionLocked) {
      return;
    }
    const capabilities = selectedEnvironmentServerConfig?.environment.capabilities;
    const insertion = flow.draftKey ? captureComposerDraftInsertion(flow.draftKey) : undefined;
    const result = await pickComposerMedia({
      existingCount:
        flow.draftKey && insertion
          ? countComposerDraftAttachmentsAfterSelection(flow.draftKey, insertion)
          : flow.attachments.length,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount =
      result.attachments.length > 0 ? flow.appendAttachments(result.attachments, insertion) : 0;
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Dialog.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }

  async function handlePickFiles(): Promise<void> {
    if (isComposerInteractionLocked) {
      return;
    }
    const maxBytes =
      selectedEnvironmentServerConfig?.environment.capabilities.fileAttachments?.maxUploadBytes;
    if (maxBytes === undefined) {
      Dialog.alert("File attachments are not available on this server.");
      return;
    }
    const insertion = flow.draftKey ? captureComposerDraftInsertion(flow.draftKey) : undefined;
    const result = await pickComposerFiles({
      existingCount:
        flow.draftKey && insertion
          ? countComposerDraftAttachmentsAfterSelection(flow.draftKey, insertion)
          : flow.attachments.length,
      maxBytes,
    });
    const rejectedCount =
      result.files.length > 0 ? flow.appendAttachments(result.files, insertion) : 0;
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Dialog.alert("Could not attach file", problems.join("\n\n"));
    }
  }

  const handleNativePasteImages = async (uris: ReadonlyArray<string>) => {
    const insertion = flow.draftKey ? captureComposerDraftInsertion(flow.draftKey) : undefined;
    const existingCount =
      flow.draftKey && insertion
        ? countComposerDraftAttachmentsAfterSelection(flow.draftKey, insertion)
        : flow.attachments.length;
    const converted = await settlePromise(() =>
      convertPastedImagesToAttachments({ uris, existingCount }),
    );
    if (AsyncResult.isFailure(converted)) {
      console.error("[native paste] error converting images", squashAtomCommandFailure(converted));
      return;
    }
    if (converted.value.length > 0) flow.appendAttachments(converted.value, insertion);
  };

  const handleNativePasteText = async (paste: ComposerTextPaste) => {
    const draftKey = flow.draftKey;
    if (!draftKey) return;
    const insertion = { text: paste.value, ...paste.selection };
    const insertPaste = () => {
      const insertion = replaceTextSelection({
        value: paste.value,
        selection: paste.selection,
        text: paste.text,
      });
      flow.setPrompt(insertion.value);
    };
    const capabilities = selectedEnvironmentServerConfig?.environment.capabilities;
    const advertisedMax =
      capabilities?.attachmentUploads === true
        ? capabilities.fileAttachments?.maxUploadBytes
        : undefined;
    const maxBytes =
      advertisedMax === undefined ? null : clampFileAttachmentUploadBytes(advertisedMax);
    const wouldExceedInputLimit =
      paste.value.length -
        Math.max(0, paste.selection.end - paste.selection.start) +
        paste.text.length >
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
    const canAttach =
      maxBytes !== null &&
      countComposerDraftAttachmentsAfterSelection(draftKey, insertion) <
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
      new TextEncoder().encode(paste.text).byteLength <= maxBytes;
    if (
      pastedTextDisposition({
        text: paste.text,
        wouldExceedInputLimit,
        canAttach: true,
      }) === "attachment"
    ) {
      if (canAttach && maxBytes !== null) {
        pendingPastedTextAttachmentCountRef.current += 1;
        setPendingPastedTextAttachmentCount(pendingPastedTextAttachmentCountRef.current);
        const attached = await settlePromise(async () => {
          if (pastedTextFileNamesRef.current.draftKey !== draftKey) {
            pastedTextFileNamesRef.current = { draftKey, names: new Set() };
          }
          const reservedNames = pastedTextFileNamesRef.current.names;
          for (const attachment of flow.attachments) reservedNames.add(attachment.name);
          const name = nextPastedTextFileName([...reservedNames]);
          reservedNames.add(name);
          const attachment = await createPastedTextComposerAttachment({
            text: paste.text,
            name,
            maxBytes,
          });
          if (latestDraftKeyRef.current !== draftKey) {
            await removePersistedComposerAttachmentFile(attachment.fileUri);
            return;
          }
          if (flow.appendAttachments([attachment], insertion) > 0) {
            await removePersistedComposerAttachmentFile(attachment.fileUri);
            Dialog.alert(
              "Could not attach pasted text",
              `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            );
          }
        });
        pendingPastedTextAttachmentCountRef.current = Math.max(
          0,
          pendingPastedTextAttachmentCountRef.current - 1,
        );
        setPendingPastedTextAttachmentCount(pendingPastedTextAttachmentCountRef.current);
        if (AsyncResult.isFailure(attached)) {
          const error = squashAtomCommandFailure(attached);
          Dialog.alert(
            "Could not attach pasted text",
            error instanceof Error ? error.message : "Try again.",
          );
        }
        return;
      } else if (!wouldExceedInputLimit) {
        insertPaste();
      } else {
        Dialog.alert(
          wouldExceedInputLimit
            ? "Pasted text is too large for this message"
            : "Could not attach pasted text",
          wouldExceedInputLimit
            ? "Remove some text or an attachment, then paste again."
            : "Remove an attachment or use a smaller paste, then try again.",
        );
      }
      return;
    }

    insertPaste();
  };

  async function handleStart(): Promise<import("@t3tools/contracts").MessageId | null> {
    if (pendingPastedTextAttachmentCountRef.current > 0) return null;
    const selectedProject = flow.selectedProject;
    const draftKey = flow.draftKey;
    if (!selectedProject || !draftKey) {
      return null;
    }
    if (
      environmentConnected &&
      !readEnvironmentScope(selectedProject.environmentId, AuthOrchestrationOperateScope)
    ) {
      return null;
    }
    const draft = getComposerDraftSnapshot(draftKey);
    if (appAtomRegistry.get(composerContextImportsAtom)[draftKey]) return null;
    const modelSelection =
      resolveSelectableModelSelection(
        selectedEnvironmentServerConfig,
        draft.modelSelection ?? null,
        selectedProject.id,
      ) ?? flow.selectedModel;
    const workspaceSelection = resolveNewTaskWorkspaceSelection({
      selection: draft.workspaceSelection,
      fallback: {
        mode: flow.workspaceMode,
        branch: flow.selectedBranchName,
        worktreePath: flow.selectedWorktreePath,
      },
      isGitRepo: flow.isGitRepo,
    });
    const workspaceMode = workspaceSelection.mode;
    const selectedBranchName = workspaceSelection.branch;
    const initialMessageText = draft.text.trim();

    if (
      attachmentBlockReason !== null ||
      !modelSelection ||
      (initialMessageText.length === 0 && draft.attachments.length === 0) ||
      flow.submitting ||
      (workspaceMode === "worktree" && !selectedBranchName)
    ) {
      return null;
    }
    if (
      environmentConnected &&
      isModelSelectionUnavailable(
        selectedEnvironmentServerConfig,
        modelSelection,
        selectedProject.id,
      )
    ) {
      const { title, detail } = describeUnavailableModelSelection(
        selectedEnvironmentServerConfig,
        modelSelection,
        selectedProject.id,
      );
      Dialog.alert(title, detail);
      return null;
    }
    // T3's own limits command is answered by the thread composer; a new task would
    // send it to the agent. A provider's same-named command, or a prompt carrying
    // attachments, goes through as usual.
    if (
      offersUsageLimits &&
      isUsageLimitsCommand(initialMessageText) &&
      draft.attachments.length === 0
    ) {
      Dialog.alert(
        "Usage limits",
        "Send /usage-limits inside a thread, or open Settings → Usage → Limits.",
      );
      return null;
    }
    // A failed-send restore can leave the draft over the cap on purpose (it
    // never drops the user's files); starting anyway would upload everything
    // and have the server reject the turn.
    if (draft.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Dialog.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }

    const contextBlockReason = composerContextSendBlockReason(draft.context);
    if (contextBlockReason) {
      Dialog.alert("Too much context", contextBlockReason);
      return null;
    }
    const strandedThread = threadContextsOutsideEnvironment({
      text: draft.text,
      records: draft.context?.records ?? [],
      environmentId: selectedProject.environmentId,
    })[0];
    if (strandedThread) {
      const owner =
        flow.environments.find(
          (environment) => environment.environmentId === strandedThread.environmentId,
        )?.environmentLabel ?? "its machine";
      Dialog.alert(
        "Attached thread unavailable",
        `"${strandedThread.title}" is on another machine. Switch back to ${owner} or remove it from the draft.`,
      );
      return null;
    }

    const editingPendingTask = flow.editingPendingTask;

    const metadata = editingPendingTask
      ? {
          threadId: editingPendingTask.threadId,
          commandId: editingPendingTask.commandId,
          messageId: editingPendingTask.messageId,
          createdAt: editingPendingTask.createdAt,
        }
      : creationMetadata;
    const message = flow.buildPendingTaskMessage(metadata, {
      currentCheckoutBranch: queuesInsteadOfStarting ? null : flow.currentCheckoutBranchName,
    });
    if (!message) {
      return null;
    }
    if (!queuesInsteadOfStarting) {
      // Arm the lock-screen card before the async thread creation: backgrounding
      // the app right after tapping submit would otherwise reject the foreground
      // -only Activity start. If creation fails, the token registration's replay
      // finds no work and ends the card within seconds.
      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: selectedProject.environmentId,
        threadTitle: deriveThreadTitleSeed({
          text: initialMessageText,
          attachments: draft.attachments,
        }),
        projectTitle: selectedProject.title,
      });
    }
    // Persist before clearing the draft or leaving its editor. This only waits
    // for the local outbox write; server and worktree setup run on the thread.
    flow.setSubmitting(true);
    const queued = await settlePromise(() => enqueueThreadOutboxMessage(message));
    flow.setSubmitting(false);
    if (AsyncResult.isFailure(queued)) {
      const error = squashAtomCommandFailure(queued);
      Dialog.alert(
        "Could not queue task",
        error instanceof Error ? error.message : "The task could not be saved to the outbox.",
      );
      return null;
    }
    navigation.dispatch(
      CommonActions.setParams(
        submittedThreadParams(String(message.environmentId), String(message.threadId)),
      ),
    );
    const draftSnapshot = getComposerDraftSnapshot(draftKey);
    if (editingPendingTask) {
      flow.finishEditingPendingTask();
    } else {
      // The queued message owns the attachments now, so the sweep is deferred
      // until the write confirms it.
      clearComposerDraftContent(draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
        deferAttachmentCleanup: true,
      });
    }
    scheduleUnusedComposerAttachmentCleanup(draftSnapshot.attachments);
    return message.messageId;
  }

  if (!selectedProject) {
    return (
      <ThreadScreenFallback>
        <View className="flex-1 bg-screen" collapsable={false}>
          {Platform.OS === "android" ? (
            <>
              <NativeStackScreenOptions options={{ headerShown: false }} />
              <AndroidScreenHeader
                title="New thread"
                hideBottomBorder
                onBack={() => navigation.goBack()}
              />
            </>
          ) : (
            <NativeStackScreenOptions options={{ title: "Loading task" }} />
          )}
        </View>
      </ThreadScreenFallback>
    );
  }

  const canStart =
    !isImportingContext &&
    !cloneBlocksStart &&
    taskPermissionReason === null &&
    attachmentBlockReason === null &&
    !modelUnavailable &&
    Boolean(flow.selectedProject) &&
    Boolean(flow.selectedModel) &&
    (flow.prompt.trim().length > 0 || flow.attachments.length > 0) &&
    isIncomingShareReady &&
    !isImportingShare &&
    !flow.submitting &&
    pendingPastedTextAttachmentCount === 0 &&
    // Until the repository check answers, a saved worktree selection may belong to a non-git folder.
    !(flow.workspaceMode === "worktree" && (!flow.selectedBranchName || !flow.isGitRepoKnown));
  const closeNewTask = () => {
    void KeyboardController.dismiss({ animated: true });
    navigation.goBack();
  };
  const chooseProject = () => {
    if (isComposerInteractionLocked) {
      return;
    }
    promptInputRef.current?.blur();
    void KeyboardController.dismiss({ animated: true });
    navigation.navigate("NewTaskSheet", {
      screen: "NewTask",
      params: { incomingShareId: props.incomingShareId },
    });
  };
  const openContextPicker = (routeName: "NewTaskBranch" | "NewTaskEnvironment") => {
    if (isComposerInteractionLocked) {
      return;
    }
    promptInputRef.current?.blur();
    void KeyboardController.dismiss({ animated: true });
    navigation.navigate("NewTaskSheet", { screen: routeName });
  };

  const environmentControl = (
    <ComposerInlineControl
      accessibilityLabel={`Environment: ${selectedEnvironmentLabel}`}
      chevronDirection="right"
      disabled={isComposerInteractionLocked}
      renderIcon={(size) => (
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(selectedEnvironmentServerConfig)}
          size={size}
          tintColorClassName="accent-icon-muted"
        />
      )}
      label={`on ${selectedEnvironmentLabel}`}
      maxWidth={flow.isScratchDraft ? 170 : 260}
      onPress={
        flow.environments.length > 1 ? () => openContextPicker("NewTaskEnvironment") : undefined
      }
      showChevron={flow.environments.length > 1}
      static={flow.environments.length <= 1}
    />
  );
  const hero = flow.isScratchDraft ? (
    <View className="items-center gap-2 px-6" testID="new-task-hero">
      <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
        What should we work on?
      </Text>
      <View className="flex-row flex-wrap items-center justify-center gap-x-1">
        <ComposerInlineControl
          accessibilityHint="Opens the project picker"
          accessibilityLabel="No project"
          chevronDirection="right"
          disabled={isComposerInteractionLocked}
          icon="folder"
          label="No project"
          onPress={chooseProject}
        />
        {environmentControl}
      </View>
    </View>
  ) : (
    <View className="items-center gap-6 px-6" testID="new-task-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we build
        </Text>
        <View className="max-w-full flex-row items-center justify-center">
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">in </Text>
          <Pressable
            accessibilityHint="Opens the project picker"
            accessibilityLabel={selectedProjectLabel ?? selectedProject.title}
            accessibilityRole="button"
            disabled={isComposerInteractionLocked}
            onPress={chooseProject}
            className="min-w-0 max-w-[250px] border-b border-foreground-muted active:opacity-65"
          >
            <Text
              className="text-2xl font-t3-medium tracking-tight text-foreground"
              numberOfLines={1}
            >
              {selectedProjectLabel ?? selectedProject.title}
            </Text>
          </Pressable>
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">?</Text>
        </View>
      </View>

      {environmentControl}
    </View>
  );
  const heroViewport = (headerInset: number) => (
    <NativeScrollEdgeEffectsContext
      value={{ top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" }}
    >
      <View className="flex-1" collapsable={false}>
        <ScrollView
          alwaysBounceVertical={false}
          className="flex-1"
          contentInsetAdjustmentBehavior="never"
          contentContainerClassName="grow items-center pb-[236px]"
          contentContainerStyle={{ paddingTop: headerInset + 24 }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          testID="new-task-hero-scroll"
        >
          {hero}
        </ScrollView>
      </View>
    </NativeScrollEdgeEffectsContext>
  );

  const workspaceControls = (
    <View className="flex-row items-center gap-1 px-2">
      <ComposerInlineControl
        accessibilityHint={`Switches to ${flow.workspaceMode === "local" ? "a new worktree" : "the current checkout"}`}
        accessibilityLabel={workspaceLabel}
        disabled={isComposerInteractionLocked || !flow.isGitRepo}
        renderIcon={(size) => (
          <NewTaskWorkspaceIcon
            workspaceMode={flow.workspaceMode}
            worktreePath={flow.selectedWorktreePath}
            size={size}
          />
        )}
        label={workspaceLabel}
        maxWidth={flow.workspaceMode === "local" ? 220 : 148}
        onPress={() => flow.setWorkspaceMode(flow.workspaceMode === "local" ? "worktree" : "local")}
        showChevron={false}
      />

      <ComposerInlineControl
        accessibilityLabel={`${flow.workspaceMode === "worktree" ? "Base branch" : "Branch"}: ${selectedBranchLabel}`}
        chevronDirection="right"
        disabled={isComposerInteractionLocked || !flow.isGitRepo}
        icon="arrow.triangle.branch"
        label={showBranchLoading ? "Loading branches…" : selectedBranchLabel}
        maxWidth={190}
        onPress={() => openContextPicker("NewTaskBranch")}
      />
    </View>
  );

  if (!flow.selectedModel) return null;
  const thread = draftThreadShell({
    environmentId: selectedProject.environmentId,
    projectId: selectedProject.id,
    threadId: ThreadId.make(flow.editingPendingTask?.threadId ?? creationMetadata.threadId),
    modelSelection: flow.selectedModel,
    runtimeMode: flow.runtimeMode,
    interactionMode: flow.interactionMode,
    branch: flow.selectedBranchName,
    worktreePath: flow.selectedWorktreePath,
    createdAt: creationMetadata.createdAt,
  });
  return (
    <>
      <AppBar
        title="New thread"
        onBack={closeNewTask}
        hideBottomBorder
        options={{
          title: "New thread",
          headerTitle: "New thread",
          unstable_headerSubtitle: undefined,
          unstable_headerLeftItems: undefined,
          unstable_headerRightItems: () => [],
          unstable_headerToolbarItems: () => [],
          headerShadowVisible: false,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          scrollEdgeEffects: { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" },
        }}
      />
      <ThreadScreenBinding
        draftMode={{
          content: heroViewport,
          controls: (
            <View className="px-3 pb-1">
              {projectClone && projectClone.phase !== "done" && selectedProject ? (
                <View className="px-1 pb-2">
                  <ProjectCloneBanner
                    clone={projectClone}
                    onCancel={() =>
                      void runCloneAction("Failed to cancel clone", () =>
                        cancelProjectClone({
                          environmentId: selectedProject.environmentId,
                          input: { projectId: selectedProject.id },
                        }),
                      )
                    }
                    onRetry={() =>
                      void runCloneAction("Failed to retry clone", () =>
                        retryProjectClone({
                          environmentId: selectedProject.environmentId,
                          input: { projectId: selectedProject.id },
                        }),
                      )
                    }
                    onRemove={() => void removeClonedProject()}
                  />
                </View>
              ) : null}
              {flow.canChooseWorkspace ? workspaceControls : null}
            </View>
          ),
          editorRef: promptInputRef,
          sendBlockedReason:
            canStart || (flow.prompt.length === 0 && flow.attachments.length === 0)
              ? null
              : (taskPermissionReason ?? attachmentBlockReason ?? "Task is not ready to send"),
        }}
        canOperateThread={canOperate}
        selectedThread={thread}
        selectedThreadDetailRef={null}
        contentPresentation={{ kind: "ready" }}
        screenTone={connectionTone(environmentConnected ? "connected" : "offline")}
        connectionError={null}
        environmentLabel={selectedEnvironmentLabel}
        feedbackSubmissions={[]}
        onDismissFeedback={() => {}}
        selectedThreadFeed={[]}
        activityRun={null}
        activeWorkStartedAt={null}
        isCompacting={false}
        creationState={null}
        activePendingApproval={null}
        activePendingApprovals={[]}
        respondingApprovalId={null}
        activePendingUserInput={null}
        activePendingUserInputDrafts={{}}
        activePendingUserInputAnswers={null}
        respondingUserInputId={null}
        connectionStateLabel={environmentConnected ? "connected" : "offline"}
        activeThreadBusy={false}
        canStopThread={false}
        queuedRunEdit={null}
        composerDraftKey={flow.draftKey}
        followUpBehavior="queue"
        canSteerActiveTurn={false}
        isSavingQueuedEdit={false}
        onCancelQueuedRunEdit={() => {}}
        onRemoveQueuedEditAttachment={() => {}}
        environmentId={selectedProject.environmentId}
        projectWorkspaceRoot={selectedProject.workspaceRoot}
        threadCwd={composerWorkspaceCwd}
        selectedThreadQueueCount={0}
        queuedMessages={[]}
        dispatchingMessageId={null}
        serverConfig={selectedEnvironmentServerConfig}
        usesAutomaticContentInsets
        onOpenConnectionEditor={() => {}}
        onChangeDraftMessage={flow.setPrompt}
        onPickDraftMedia={handlePickMedia}
        onPickDraftFiles={handlePickFiles}
        onNativePasteImages={handleNativePasteImages}
        onNativePasteText={handleNativePasteText}
        onRemoveDraftImage={flow.removeAttachment}
        onStopThread={() => {}}
        onResumeQueue={null}
        onSendMessage={handleStart}
        onReconnectEnvironment={() => {}}
        canSwitchThreadProvider
        onUpdateThreadModelSelection={(modelSelection) => {
          if (flow.draftKey) updateComposerDraftSettings(flow.draftKey, { modelSelection });
        }}
        onUpdateThreadRuntimeMode={flow.setRuntimeMode}
        onUpdateThreadInteractionMode={flow.setInteractionMode}
        onRespondToApproval={async () => {}}
        onSelectUserInputOption={() => {}}
        onChangeUserInputCustomAnswer={() => {}}
        onSubmitUserInput={async () => {}}
        onDismissUserInput={async () => {}}
      />
    </>
  );
}
