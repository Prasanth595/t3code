/**
 * Fork: how a sidebar group tab shows the status of its most urgent thread. The icon is the
 * `status.<kind>` theme icon slot (`AppIcon`), which the thread row badge uses too. The label and
 * colour mirror the row (`topStatus` in `SidebarThreadRow`, Sidebar.tsx); update them when
 * upstream changes a row status.
 */
import type { AppIconSlot } from "../AppIcon";
import type { SidebarV2TopStatusKind } from "../Sidebar.logic";

export interface SidebarGroupTabStatus {
  readonly kind: SidebarV2TopStatusKind;
  readonly label: string;
  readonly className: string;
  /** Every status has an icon on a tab. */
  readonly slot: AppIconSlot;
}

const TAB_STATUS: Record<SidebarV2TopStatusKind, Omit<SidebarGroupTabStatus, "kind" | "slot">> = {
  working: { label: "Working", className: "text-info" },
  waiting: { label: "Waiting", className: "text-muted-foreground" },
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  limited: { label: "Limited", className: "text-warning" },
  failed: { label: "Failed", className: "text-error" },
  woke: { label: "Woke", className: "text-warning" },
  done: { label: "Done", className: "text-success" },
};

export const sidebarGroupTabStatus = (kind: SidebarV2TopStatusKind): SidebarGroupTabStatus => ({
  kind,
  ...TAB_STATUS[kind],
  slot: `status.${kind}`,
});
