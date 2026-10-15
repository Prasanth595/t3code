import type { EnvironmentId } from "@t3tools/contracts";

import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";

/** Worktree project directories are resolved on the environment that owns the filesystem. */
export function useProjectCwd(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectCwd: string | null;
  readonly worktreePath: string | null;
}) {
  const resolved = useEnvironmentQuery(
    input.environmentId !== null && input.projectCwd !== null && input.worktreePath !== null
      ? projectEnvironment.resolveCwd({
          environmentId: input.environmentId,
          input: { cwd: input.projectCwd, worktreePath: input.worktreePath },
        })
      : null,
  );

  return input.worktreePath === null ? input.projectCwd : (resolved.data?.cwd ?? null);
}
