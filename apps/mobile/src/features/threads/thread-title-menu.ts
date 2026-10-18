import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  canSnooze,
  effectiveSnoozed,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ServerConfig } from "@t3tools/contracts";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";

export function buildThreadTitleMenu(input: {
  readonly thread: EnvironmentThreadShell;
  readonly capabilities:
    | Pick<
        ServerConfig["environment"]["capabilities"],
        "threadSettlement" | "threadSnooze" | "threadPinning" | "threadTitleRegeneration"
      >
    | undefined;
  readonly canOperate: boolean;
  readonly hasQueuedMessages: boolean;
  readonly now: Date;
}): MenuAction[] {
  const { thread, capabilities, now } = input;
  const actions: MenuAction[] = [];
  if (input.canOperate) {
    if (capabilities?.threadSettlement) {
      actions.push(
        thread.settledOverride === "settled" && !input.hasQueuedMessages
          ? { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" }
          : { id: "settle", title: "Settle", image: "checkmark" },
      );
    }
    if (capabilities?.threadSnooze) {
      if (effectiveSnoozed(thread, { now: now.toISOString() })) {
        actions.push({ id: "unsnooze", title: "Wake now", image: "sun.max" });
      } else if (canSnooze(thread, { now: now.toISOString() })) {
        actions.push({
          id: "snooze",
          title: "Snooze",
          image: "clock",
          subactions: [
            ...resolveSnoozePresets(now).map((preset) => ({
              id: `snooze:${preset.snoozedUntil}`,
              title: preset.label,
              subtitle: preset.whenLabel,
            })),
            { id: "snooze:custom", title: "Custom…" },
          ],
        });
      }
    }
    if (capabilities?.threadPinning) {
      actions.push(
        thread.pinnedAt != null
          ? { id: "unpin", title: "Unpin", image: "pin.slash" }
          : { id: "pin", title: "Pin", image: "pin" },
      );
    }
    actions.push(
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: capabilities?.threadTitleRegeneration === true,
        isRegenerating: thread.titleRegeneration != null,
      }),
    );
  }
  actions.push({ id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" });
  if (input.canOperate)
    actions.push({
      id: "delete",
      title: "Delete",
      image: "trash",
      attributes: { destructive: true },
    });
  return actions;
}

/** The native header only needs new content when its title or actions change. */
export function threadTitleMenuVersion(thread: EnvironmentThreadShell | null) {
  if (thread === null) return null;
  return [
    thread.environmentId,
    thread.id,
    thread.title,
    thread.settledOverride,
    thread.pinnedAt,
    thread.snoozedAt,
    thread.snoozedUntil,
    thread.hasPendingApprovals,
    thread.hasPendingUserInput,
    thread.pendingSubagentRequest,
    thread.latestUserMessageAt,
    thread.latestRun?.status,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
    thread.runtime?.status,
    thread.runtime?.status === "failed" ? thread.runtime.updatedAt : null,
    thread.titleRegeneration,
  ];
}

/** Carry the displayed instant in the action ID, even if the menu spans midnight. */
export function threadTitleSnoozeUntil(event: string, now: Date): string | null {
  if (!event.startsWith("snooze:")) return null;
  const until = event.slice("snooze:".length);
  return Date.parse(until) > now.getTime() ? until : null;
}
