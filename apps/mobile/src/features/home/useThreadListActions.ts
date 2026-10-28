import type { ThreadMoveDestination } from "../threads/threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./thread-undo-notice";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useRef } from "react";

import { withThreadDismissal } from "./thread-dismissal";
import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  threadDropBusyAtom,
} from "../../state/thread-order";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadDropLifecycle,
} from "../threads/threadOrder";
import { getThreadListV2OrderedSection } from "../threads/threadListV2";
import { threadCanArchive } from "./threadArchive";
import { resolveThreadTitleRename } from "../threads/thread-title-rename";

/** Older servers default the settlement capability to false; never send them settle/unsettle. */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

function environmentSupportsSnooze(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

function environmentSupportsPinning(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

function environmentSupportsPinReorder(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

function environmentSupportsAutoSettleOptOut(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
  );
}

function environmentSupportsTitleRegeneration(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";

const ACTION_VERBS: Record<ThreadListAction, string> = {
  archive: "arhivată",
  unarchive: "dezarhivată",
  delete: "ștearsă",
  settle: "finalizată",
  unsettle: "redeschisă",
};

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return `Conversația nu a putut fi ${ACTION_VERBS[action]}.`;
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Conversația nu a putut fi arhivată";
  if (action === "unarchive") return "Conversația nu a putut fi dezarhivată";
  if (action === "settle") return "Conversația nu a putut fi finalizată";
  if (action === "unsettle") return "Conversația nu a putut fi redeschisă";
  return "Conversația nu a putut fi ștearsă";
}

function checkThreadOperationPermission(thread: EnvironmentThreadShell, title: string): boolean {
  if (readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return true;
  Dialog.alert(title, "Această conexiune nu poate modifica conversații.");
  return false;
}

function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = async (
    action: ThreadListAction,
    thread: EnvironmentThreadShell,
    onStarted?: () => void,
  ) => {
    if (!checkThreadOperationPermission(thread, actionFailureTitle(action))) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (inFlightThreadKeys.current.has(key)) {
      return false;
    }

    inFlightThreadKeys.current.add(key);
    selectionHaptic();
    const succeeded = await (async () => {
      if (
        (action === "settle" || action === "unsettle") &&
        !environmentSupportsSettlement(thread.environmentId)
      ) {
        Dialog.alert(
          actionFailureTitle(action),
          "Serverul acestui mediu nu suportă încă finalizarea. Actualizează serverul ca să folosești Finalizează.",
        );
        return false;
      }
      if (action === "archive" && !threadCanArchive(thread.runtime)) {
        Dialog.alert(
          actionFailureTitle(action),
          "Conversația lucrează încă. Întrerupe-o mai întâi, apoi încearcă din nou.",
        );
        return false;
      }
      if (action === "unsettle") ThreadUndo.invalidate("settle", key);
      if (action === "archive" || action === "delete") {
        for (const kind of ["settle", "snooze", "pin"]) ThreadUndo.invalidate(kind, key);
      }
      onStarted?.();
      const result = await withThreadDismissal(
        key,
        async () =>
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        Dialog.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
        return false;
      }
      if (action === "archive" || action === "unarchive" || action === "delete") {
        refreshArchivedThreadsForEnvironment(thread.environmentId);
      }
      onCompleted?.(action, thread);
      return true;
    })();
    inFlightThreadKeys.current.delete(key);
    return succeeded;
  };

  return executeAction;
}

// Hookless use* functions skip compilation, leaving their returned handlers unstable.
function confirmThreadDeletion(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
  thread: EnvironmentThreadShell,
) {
  if (!checkThreadOperationPermission(thread, actionFailureTitle("delete"))) return;
  const title = "Ștergi conversația?";
  const message = `“${thread.title}” va fi ștearsă definitiv, inclusiv istoricul terminalului.`;
  Dialog.confirm({
    title,
    message,
    confirmText: "Șterge",
    destructive: true,
    onConfirm: () => {
      void executeAction("delete", thread);
    },
  });
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly snoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly setThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly moveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly renameThread: (thread: EnvironmentThreadShell) => void;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const setAutoSettleMutation = useAtomCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  const archiveThread = (thread: EnvironmentThreadShell) => executeAction("archive", thread);
  const offerUndo = (
    thread: EnvironmentThreadShell,
    action: "finalizată" | "amânată" | "defixată",
    claim: ReturnType<typeof ThreadUndo.begin>,
    plan: ThreadUndo.ThreadUndoPlan,
  ) =>
    showThreadUndoNotice({
      action,
      claim,
      undo: async () => {
        try {
          await ThreadUndo.executeThreadUndo(
            plan,
            async (step) => {
              switch (step.action) {
                case "unsettle":
                  return unsettleThread(thread);
                case "unsnooze":
                  return unsnoozeThread(thread);
                case "pin":
                  return pinThread(thread, step.orderKey);
                case "snooze": {
                  const failureTitle =
                    action === "defixată"
                      ? "Defixarea nu a putut fi anulată"
                      : "Finalizarea nu a putut fi anulată";
                  if (!checkThreadOperationPermission(thread, failureTitle)) return false;
                  const result = await snoozeMutation({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.id, snoozedUntil: step.snoozedUntil },
                  });
                  if (result._tag === "Failure") {
                    const error = Cause.squash(result.cause);
                    Dialog.alert(
                      "Amânarea nu a putut fi restabilită",
                      error instanceof Error ? error.message : "Conversația nu a putut fi amânată.",
                    );
                    return false;
                  }
                  return true;
                }
              }
            },
            (result) => result,
          );
        } catch (error) {
          Dialog.alert(
            "Acțiunea nu a putut fi anulată",
            error instanceof Error ? error.message : "Încearcă din nou.",
          );
        }
      },
    });
  const settleThread = async (thread: EnvironmentThreadShell) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    const plan = ThreadUndo.planThreadUndo("settle", thread);
    let claim: ReturnType<typeof ThreadUndo.begin> | undefined;
    const succeeded = await executeAction("settle", thread, () => {
      ThreadUndo.invalidate("pin", key);
      ThreadUndo.invalidate("snooze", key);
      claim = ThreadUndo.begin("settle", key);
    });
    if (claim) {
      if (succeeded) offerUndo(thread, "finalizată", claim, plan);
      else claim.finish();
    }
    return succeeded;
  };
  const snoozeThread = async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
    if (!checkThreadOperationPermission(thread, "Conversația nu a putut fi amânată")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentSupportsSnooze(thread.environmentId)) {
        Dialog.alert(
          "Conversația nu a putut fi amânată",
          "Serverul acestui mediu nu suportă încă amânarea. Actualizează serverul ca să folosești Amână.",
        );
        return false;
      }
      if (!canSnooze(thread, { now: new Date().toISOString() })) {
        Dialog.alert(
          "Conversația nu a putut fi amânată",
          thread.hasPendingApprovals ||
            thread.hasPendingUserInput ||
            thread.pendingSubagentRequest != null
            ? "Conversația te așteaptă. Răspunde la cererea în așteptare înainte s-o amâni."
            : "Conversația încă pornește. Încearcă din nou după ce rulează.",
        );
        return false;
      }

      selectionHaptic();
      const claim = ThreadUndo.begin("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          snoozeMutation({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              snoozedUntil,
            },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        claim.finish();
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Conversația nu a putut fi amânată",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Conversația nu a putut fi amânată.",
        );
        return false;
      }
      offerUndo(thread, "amânată", claim, ThreadUndo.planThreadUndo("snooze"));
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsnoozeThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Conversația nu a putut fi reactivată"))
      return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentSupportsSnooze(thread.environmentId)) {
        Dialog.alert(
          "Conversația nu a putut fi reactivată",
          "Serverul acestui mediu nu suportă încă amânarea. Actualizează serverul ca să reactivezi conversația.",
        );
        return false;
      }

      selectionHaptic();
      ThreadUndo.invalidate("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          unsnoozeMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, reason: "user" },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Conversația nu a putut fi reactivată",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Conversația nu a putut fi reactivată.",
        );
        return false;
      }
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsettleThread = async (thread: EnvironmentThreadShell) =>
    (await executeAction("unsettle", thread)) === true;
  const pinThread = async (thread: EnvironmentThreadShell, restoreOrderKey?: string) => {
    if (!checkThreadOperationPermission(thread, "Conversația nu a putut fi fixată")) return false;
    if (!environmentSupportsPinning(thread.environmentId)) {
      Dialog.alert(
        "Conversația nu a putut fi fixată",
        "Serverul acestui mediu nu suportă încă fixarea. Actualizează serverul ca să folosești Fixează.",
      );
      return false;
    }
    selectionHaptic();
    let orderKey: string | undefined;
    if (environmentSupportsPinReorder(thread.environmentId)) {
      const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
      let firstKey: string | null = null;
      for (const shell of shells) {
        if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
        if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
      }
      orderKey = pinOrderKeyBetween(null, firstKey) ?? undefined;
    }
    orderKey = environmentSupportsPinReorder(thread.environmentId)
      ? (restoreOrderKey ?? orderKey)
      : undefined;
    ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
    ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        pinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, ...(orderKey !== undefined ? { orderKey } : {}) },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Conversația nu a putut fi fixată",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Conversația nu a putut fi fixată.",
      );
      return false;
    }
    return true;
  };
  const unpinThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Conversația nu a putut fi defixată")) return false;
    if (!environmentSupportsPinning(thread.environmentId)) {
      Dialog.alert(
        "Conversația nu a putut fi defixată",
        "Serverul acestui mediu nu suportă încă fixarea. Actualizează serverul ca să folosești Fixează.",
      );
      return false;
    }
    selectionHaptic();
    const plan = ThreadUndo.planThreadUndo("unpin", thread);
    const claim = ThreadUndo.begin("pin", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        unpinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      claim.finish();
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Conversația nu a putut fi defixată",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Conversația nu a putut fi defixată.",
      );
      return false;
    }
    offerUndo(thread, "defixată", claim, plan);
    return true;
  };
  const setThreadAutoSettle = async (thread: EnvironmentThreadShell, enabled: boolean) => {
    if (!environmentSupportsAutoSettleOptOut(thread.environmentId)) {
      Dialog.alert(
        "Finalizarea automată nu a putut fi schimbată",
        "Serverul acestui mediu nu suportă încă oprirea finalizării automate per conversație. Actualizează serverul ca s-o folosești.",
      );
      return false;
    }
    selectionHaptic();
    const result = await setAutoSettleMutation({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, enabled },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Finalizarea automată nu a putut fi schimbată",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Setarea de finalizare automată nu a putut fi schimbată.",
      );
      return false;
    }
    return true;
  };
  const regenerateThreadTitle = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Titlul nu a putut fi regenerat")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (thread.titleRegeneration != null || titleRegenerationInFlightThreadKeys.current.has(key)) {
      return false;
    }
    if (!environmentSupportsTitleRegeneration(thread.environmentId)) {
      Dialog.alert(
        "Titlul nu a putut fi regenerat",
        "Serverul acestui mediu nu suportă încă regenerarea titlurilor. Actualizează serverul ca să regenerezi titlurile.",
      );
      return false;
    }

    titleRegenerationInFlightThreadKeys.current.add(key);
    selectionHaptic();
    const succeeded = await (async () => {
      const result = await updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, regenerateTitle: true },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Titlul nu a putut fi regenerat",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Titlul conversației nu a putut fi regenerat.",
        );
        return false;
      }
      return true;
    })();
    titleRegenerationInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const renameThread = (thread: EnvironmentThreadShell) => {
    const commit = (title: string) => {
      const resolution = resolveThreadTitleRename({ title, originalTitle: thread.title });
      if (resolution.action === "reject-empty") {
        Dialog.alert("Conversația nu a putut fi redenumită", "Titlul nu poate fi gol.");
        return;
      }
      if (resolution.action === "noop") return;
      selectionHaptic();
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Success") return;
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Conversația nu a putut fi redenumită",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Conversația nu a putut fi redenumită.",
        );
      });
    };

    Dialog.prompt({
      title: "Redenumește conversația",
      initialValue: thread.title,
      confirmText: "Redenumește",
      onConfirm: commit,
    });
  };

  // Plan against the complete section so filtering does not change a move.
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveMutation = useAtomCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const moveThread = async (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    if (!checkThreadOperationPermission(thread, "Conversația nu a putut fi mutată")) return false;
    if (getPendingThreadOrder() !== null || appAtomRegistry.get(threadDropBusyAtom)) return false;
    const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const current = shells.find(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    if (!current || current.archivedAt !== null) return false;
    thread = current;
    const section =
      typeof direction === "object" && direction.section !== undefined
        ? direction.section
        : thread.pinnedAt != null
          ? "pinned"
          : "active";
    if (section === "settled") {
      if (!environmentSupportsSettlement(thread.environmentId)) return false;
      appAtomRegistry.set(threadDropBusyAtom, true);
      const settled = await settleThread(thread);
      appAtomRegistry.set(threadDropBusyAtom, false);
      return settled;
    }
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const supportsReorder = (environmentId: EnvironmentThreadShell["environmentId"]) => {
      const capabilities = configs.get(environmentId)?.environment.capabilities;
      return section === "pinned"
        ? capabilities?.threadPinReorder === true
        : capabilities?.threadActiveReorder === true;
    };
    if (!supportsReorder(thread.environmentId)) {
      Dialog.alert(
        "Conversația nu a putut fi mutată",
        "Serverul acestui mediu nu suportă reordonarea acestor conversații. Actualizează serverul ca să le aranjezi.",
      );
      return false;
    }
    const ordered = getThreadListV2OrderedSection({
      threads: shells,
      section,
      now: new Date().toISOString(),
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSettlement === true ? [id] : [],
        ),
      ),
      snoozeEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSnooze === true ? [id] : [],
        ),
      ),
    });
    const assignments = createThreadMovePlanner({
      allThreads: shells,
      ordered,
      section,
      reorderableEnvironmentIds: new Set([...configs.keys()].filter(supportsReorder)),
    })(scopedThreadKey(thread.environmentId, thread.id), direction);
    if (assignments === null) return false;
    const lifecycle = threadDropLifecycle(thread, section, new Date().toISOString());
    const crossSection = !ordered.some(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    if (
      crossSection &&
      (((section === "pinned" || thread.pinnedAt != null) &&
        !environmentSupportsPinning(thread.environmentId)) ||
        (thread.settledOverride === "settled" &&
          !environmentSupportsSettlement(thread.environmentId)) ||
        (effectiveSnoozed(thread, { now: new Date().toISOString() }) &&
          !environmentSupportsSnooze(thread.environmentId)))
    )
      return false;
    const shellByKey = new Map(
      shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
    );
    for (const assignment of assignments) {
      const target = shellByKey.get(assignment.id);
      if (target && !checkThreadOperationPermission(target, "Conversația nu a putut fi mutată"))
        return false;
    }
    selectionHaptic();
    appAtomRegistry.set(threadDropBusyAtom, true);
    const pending = crossSection
      ? null
      : beginPendingThreadOrder(
          createPendingThreadOrder({
            section,
            ordered,
            movedId: scopedThreadKey(thread.environmentId, thread.id),
            direction,
            assignments,
          }),
        );
    const reorder = section === "pinned" ? reorderPinnedMutation : reorderActiveMutation;
    const moved = await (async () => {
      if (crossSection) {
        if (section === "pinned") {
          const orderKey = assignments.find(
            ({ id }) => id === scopedThreadKey(thread.environmentId, thread.id),
          )?.orderKey;
          // Same as pinThread: older Unpinned, Settled, or Snoozed undos would fight this pin.
          ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
          const result = await pinMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, ...(orderKey === undefined ? {} : { orderKey }) },
          });
          if (result._tag === "Failure") {
            Dialog.alert("Conversația nu a putut fi fixată", String(Cause.squash(result.cause)));
            return false;
          }
        } else {
          if (lifecycle.unpin && !(await unpinThread(thread))) return false;
          if (lifecycle.unsettle && !(await unsettleThread(thread))) return false;
          if (lifecycle.unsnooze && !(await unsnoozeThread(thread))) return false;
        }
      }
      for (const assignment of assignments) {
        if (
          crossSection &&
          section === "pinned" &&
          thread.pinnedAt == null &&
          assignment.id === scopedThreadKey(thread.environmentId, thread.id)
        )
          continue;
        if (pending !== null && !pending.isPending()) return false;
        const target = shellByKey.get(assignment.id);
        if (target === undefined) continue;
        if (!checkThreadOperationPermission(target, "Conversația nu a putut fi mutată"))
          return false;
        ThreadUndo.invalidate("pin", scopedThreadKey(target.environmentId, target.id));
        const result = await reorder({
          environmentId: target.environmentId,
          input: { threadId: target.id, orderKey: assignment.orderKey },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Dialog.alert(
            "Conversația nu a putut fi mutată",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Conversația nu a putut fi mutată.",
          );
          return false;
        }
      }
      pending?.complete();
      return true;
    })();
    if (!moved) pending?.cancel();
    appAtomRegistry.set(threadDropBusyAtom, false);
    return moved;
  };

  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
  };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
    onCompleted(thread);
  };
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = (thread: EnvironmentThreadShell) => {
    void executeAction("unarchive", thread);
  };
  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  return { unarchiveThread, confirmDeleteThread };
}
