import { type BranchNamingMode, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { formatGeneratedBranchName, sanitizeBranchFragment } from "./git.ts";

/** Words a small model puts in a branch name or title slot when it has no subject to go on. */
const PLACEHOLDER_NAME =
  /^(?:placeholder|example|branch|string|new-branch|untitled|tbd|todo|name)(?:-\d+)?$/;

/** Whether a branch name ends in a stand-in word, bare, numbered (`feat/placeholder-3`) or wrapped (`<branch>`), in any case. */
export function isPlaceholderName(raw: string): boolean {
  return PLACEHOLDER_NAME.test(sanitizeBranchFragment(raw).split("/").at(-1) ?? "");
}

/** Whether a title is a stand-in word, bare, numbered or wrapped, in any case. Unlike a branch name it is not slugged, so `New branch` stays a title. */
export function isPlaceholderTitle(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  const unwrapped = /^<.*>$|^\[.*\]$/.test(lower) ? lower.slice(1, -1).trim() : lower;
  return PLACEHOLDER_NAME.test(unwrapped);
}

const DEFAULT_THREAD_TITLE = "New thread";
const TITLE_SLUG_MAX_CHARS = 48;

interface BranchNaming {
  readonly mode: BranchNamingMode;
  readonly prefix: string;
}

interface BranchNameRequest {
  readonly message: string;
  readonly naming?: BranchNaming | undefined;
  readonly modelSelection: { readonly instanceId: string; readonly model: string };
}

interface GeneratedBranch {
  readonly branch: string;
}

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
  naming: BranchNaming | undefined,
): string | undefined {
  // A custom convention is the user's to define, and a title slug would break it.
  if (naming?.mode === "custom") return undefined;
  const slug = (namingTitle(title) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TITLE_SLUG_MAX_CHARS)
    .replace(/-+$/, "");
  if (slug === "") return undefined;
  return formatGeneratedBranchName(slug, naming && { ...naming, instructions: "" });
}

/**
 * Branch-name generation for a launch titled `title`: the model sees the title,
 * a stand-in answer is rejected, and a failed or rejected answer names the
 * branch after the title. Without a title branch the failure stands, so the
 * temporary branch is kept.
 */
export function withLaunchTitle<I extends BranchNameRequest, E>(
  textGeneration: {
    readonly generateBranchName: (input: I) => Effect.Effect<GeneratedBranch, E>;
  },
  title: string,
) {
  const generateBranchName = (
    input: I,
  ): Effect.Effect<GeneratedBranch, E | TextGenerationError> => {
    const fallback = titleBranchName(title, input.naming);
    const model = {
      model: input.modelSelection.model,
      instanceId: input.modelSelection.instanceId,
    };
    const onFailure = (cause: E): Effect.Effect<GeneratedBranch, E> =>
      fallback === undefined
        ? Effect.fail(cause)
        : Effect.logWarning("Branch name generation failed; naming the branch after the title", {
            ...model,
            branch: fallback,
            cause,
          }).pipe(Effect.as({ branch: fallback }));
    const onPlaceholder = (
      named: GeneratedBranch,
    ): Effect.Effect<GeneratedBranch, TextGenerationError> =>
      Effect.logWarning("Generated branch name is a placeholder", {
        ...model,
        branch: named.branch,
        fallback: fallback ?? null,
      }).pipe(
        Effect.andThen(
          fallback === undefined
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateBranchName",
                  detail: `The model returned the placeholder branch name '${named.branch}'.`,
                }),
              )
            : Effect.succeed({ branch: fallback }),
        ),
      );
    return textGeneration
      .generateBranchName({ ...input, message: branchNameMessage(title, input.message) })
      .pipe(
        Effect.catch(onFailure),
        Effect.filterOrElse(
          (named: GeneratedBranch) => !isPlaceholderName(named.branch),
          onPlaceholder,
        ),
      );
  };
  return { generateBranchName };
}
