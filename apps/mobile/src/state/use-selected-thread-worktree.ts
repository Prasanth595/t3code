import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useMemo } from "react";

import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: detailWorktreePath,
      }),
    [detailWorktreePath, selectedThread?.worktreePath],
  );

  return {
    selectedThreadWorktreePath,
    // Git reads run at the checkout root.
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    // Where the thread works: the project's directory, inside its worktree
    // when it has one.
    selectedThreadWorkingDirectory: selectedThreadProject
      ? projectScriptCwd({
          project: {
            cwd: selectedThreadProject.workspaceRoot,
            repositoryRoot: selectedThreadProject.repositoryIdentity?.rootPath,
          },
          worktreePath: selectedThreadWorktreePath,
        })
      : selectedThreadWorktreePath,
  };
}
