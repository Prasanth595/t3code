import { type BranchNamingMode, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { formatGeneratedBranchName, sanitizeBranchFragment } from "./git.ts";

/** Words a small model puts in a branch name or title slot when it has no subject to go on. */
const PLACEHOLDER_NAME =
  /^(?:placeholder|example|branch|string|new-branch|untitled|tbd|todo|name)(?:-\d+)?$/;

const DEFAULT_THREAD_TITLE = "New thread";
const TITLE_SLUG_MAX_CHARS = 48;

/** Whether `raw` is a stand-in word, bare, numbered (`placeholder-3`) or wrapped (`<branch>`, `[todo]`), in any case. */
export function isPlaceholderName(raw: string): boolean {
  return PLACEHOLDER_NAME.test(sanitizeBranchFragment(raw));
}

/** Fails a model's branch name that is a stand-in word, with one warning naming the model and the raw value. */
export const rejectPlaceholderBranch = Effect.fn("rejectPlaceholderBranch")(function* (
  branch: string,
  modelSelection: { readonly instanceId: string; readonly model: string },
) {
  if (!isPlaceholderName(branch)) return;
  yield* Effect.logWarning("Generated branch name is a placeholder", {
    model: modelSelection.model,
    instanceId: modelSelection.instanceId,
    branch,
  });
  return yield* new TextGenerationError({
    operation: "generateBranchName",
    detail: `The model returned the placeholder branch name '${branch}'.`,
  });
});

/** The launch title to name a branch after: none when it is empty, the default title or a stand-in word. */
function namingTitle(title: string): string | undefined {
  const trimmed = title.trim();
  return trimmed === "" || trimmed === DEFAULT_THREAD_TITLE || isPlaceholderName(trimmed)
    ? undefined
    : trimmed;
}

/** The message a branch name is generated from, led by the launch title when it has one. */
export function branchNameMessage(title: string, message: string): string {
  const named = namingTitle(title);
  return named === undefined ? message : `${named}\n\n${message}`;
}

/** A branch named after the launch title under the configured prefix, or none when the title gives nothing. */
export function titleBranchName(
  title: string,
  settings: { readonly branchNamingMode: BranchNamingMode; readonly branchNamePrefix: string },
): string | undefined {
  const slug = (namingTitle(title) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TITLE_SLUG_MAX_CHARS)
    .replace(/-+$/, "");
  if (slug === "") return undefined;
  return formatGeneratedBranchName(slug, {
    mode: settings.branchNamingMode,
    prefix: settings.branchNamePrefix,
    instructions: "",
  });
}

/** Names the branch after the launch title when generation fails; keeps the failure when the title gives nothing. */
export const orTitleBranch =
  (
    title: string,
    settings: { readonly branchNamingMode: BranchNamingMode; readonly branchNamePrefix: string },
  ) =>
  <E>(error: E) => {
    const branch = titleBranchName(title, settings);
    return branch === undefined
      ? Effect.fail(error)
      : Effect.logInfo("Naming the worktree branch after the thread title", {
          branch,
          cause: error,
        }).pipe(Effect.as({ branch, exactName: false }));
  };
