import type { ReactElement } from "react";
import { AppSheet } from "../../components/AppSheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
  /** Defaults to "Worktree setup". */
  title?: string;
}

export function WorktreeSetupSheet({
  children,
  onClose,
  title = "Worktree setup",
}: WorktreeSetupSheetProps) {
  return (
    <AppSheet title={title} onClose={onClose}>
      {children}
    </AppSheet>
  );
}
