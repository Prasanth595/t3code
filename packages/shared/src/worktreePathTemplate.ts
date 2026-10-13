import type { BranchNamingMode } from "@t3tools/contracts";

import { formatGeneratedBranchName, sanitizeBranchFragment } from "./git.ts";

/**
 * Values for a `worktreePathTemplate` such as `{repoDir}/{branchLeaf}`.
 * `repoDir` is the parent of the Git common dir: the checkout of a normal
 * clone, or the container folder of a `.bare` layout.
 */
export interface WorktreePathVariables {
  readonly worktrees: string;
  readonly repoDir: string;
  readonly repo: string;
  readonly branch: string;
  readonly branchLeaf: string;
}

export const WORKTREE_PATH_VARIABLES = [
  "worktrees",
  "repoDir",
  "repo",
  "branch",
  "branchLeaf",
] as const satisfies ReadonlyArray<keyof WorktreePathVariables>;

const BRANCH_VARIABLES = ["{branch}", "{branchLeaf}"];

/** Null when valid, else a message for the settings field. */
export function validateWorktreePathTemplate(template: string): string | null {
  let rest = template;
  for (let open = rest.indexOf("{"); open !== -1; open = rest.indexOf("{")) {
    const close = rest.indexOf("}", open);
    if (close === -1) return "A { has no matching }.";
    const name = rest.slice(open + 1, close);
    if (!(WORKTREE_PATH_VARIABLES as ReadonlyArray<string>).includes(name))
      return `Unknown variable {${name}}. Use ${WORKTREE_PATH_VARIABLES.map((variable) => `{${variable}}`).join(", ")}.`;
    rest = rest.slice(close + 1);
  }
  // Without a branch variable, every worktree of a repository gets the same folder.
  if (!BRANCH_VARIABLES.some((variable) => template.includes(variable)))
    return "Include {branch} or {branchLeaf}, so that each branch gets its own folder.";
  return null;
}

/** Substitutes the variables. Call `validateWorktreePathTemplate` first. */
export function expandWorktreePathTemplate(
  template: string,
  variables: WorktreePathVariables,
): string {
  let expanded = template;
  for (const name of WORKTREE_PATH_VARIABLES) {
    expanded = expanded.replaceAll(`{${name}}`, variables[name]);
  }
  return expanded;
}

export function worktreePathBranchVariables(
  branch: string,
): Pick<WorktreePathVariables, "branch" | "branchLeaf"> {
  return {
    branch: branch.replaceAll("/", "-"),
    branchLeaf: branch.slice(branch.lastIndexOf("/") + 1),
  };
}

const MESSAGE_BRANCH_WORDS = 6;

/**
 * A branch name from the first words of a message, so the worktree folder
 * gets its final name before it exists. Only the static mode adds its prefix:
 * the semantic and custom modes need a model, which would delay the launch.
 */
export function branchNameFromMessage(
  text: string,
  naming: { readonly mode: BranchNamingMode; readonly prefix: string },
): string {
  const words = text.trim().split(/\s+/).slice(0, MESSAGE_BRANCH_WORDS).join(" ");
  return naming.mode === "static"
    ? formatGeneratedBranchName(words, { ...naming, instructions: "" })
    : sanitizeBranchFragment(words);
}
