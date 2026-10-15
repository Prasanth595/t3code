/**
 * Fork: how a sidebar group tab shows the status of its most urgent thread. The icon comes from
 * `THREAD_STATUS_ICONS`, which the thread row badge uses too. The label and colour mirror the row
 * (`topStatus` in `SidebarThreadRow`, Sidebar.tsx); update them when upstream changes a row status.
 */
import type { LucideIcon } from "lucide-react";

import type { SidebarV2TopStatusKind } from "../Sidebar.logic";
import { THREAD_STATUS_ICONS } from "./threadCardParts";

export interface SidebarGroupTabStatus {
  readonly kind: SidebarV2TopStatusKind;
  readonly label: string;
  readonly className: string;
  /** Every status has an icon on a tab. */
  readonly Icon: LucideIcon;
}

const TAB_STATUS: Record<
  SidebarV2TopStatusKind,
  Pick<SidebarGroupTabStatus, "label" | "className">
> = {
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
  Icon: THREAD_STATUS_ICONS[kind],
});
