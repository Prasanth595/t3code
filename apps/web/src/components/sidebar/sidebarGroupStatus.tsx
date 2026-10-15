/**
 * Fork: how a sidebar group tab shows the status of its most urgent thread. It mirrors the label,
 * icon and color of the thread row (`topStatus` in `SidebarThreadRow`, Sidebar.tsx), so a status
 * reads the same on a tab and on a row. The row keeps its upstream code; update this table when
 * upstream changes a row status.
 */
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import type { SidebarV2TopStatusKind } from "../Sidebar.logic";

export interface SidebarGroupTabStatus {
  readonly kind: SidebarV2TopStatusKind;
  readonly label: string;
  readonly className: string;
  /** Every status has an icon on a tab. A row shows Waiting as a label only. */
  readonly Icon: LucideIcon;
}

const TAB_STATUS: Record<SidebarV2TopStatusKind, Omit<SidebarGroupTabStatus, "kind">> = {
  working: { label: "Working", className: "text-info", Icon: CircleDashedIcon },
  waiting: { label: "Waiting", className: "text-muted-foreground", Icon: HourglassIcon },
  approval: { label: "Approval", className: "text-warning-foreground", Icon: ShieldQuestionIcon },
  input: {
    label: "Input",
    className: "text-indigo-600 dark:text-indigo-300",
    Icon: MessageCircleQuestionIcon,
  },
  limited: { label: "Limited", className: "text-warning", Icon: CircleAlertIcon },
  failed: { label: "Failed", className: "text-error", Icon: CircleAlertIcon },
  woke: { label: "Woke", className: "text-warning", Icon: AlarmClockIcon },
  done: { label: "Done", className: "text-success", Icon: CircleCheckIcon },
};

export const sidebarGroupTabStatus = (kind: SidebarV2TopStatusKind): SidebarGroupTabStatus => ({
  kind,
  ...TAB_STATUS[kind],
});
