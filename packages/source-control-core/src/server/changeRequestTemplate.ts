/**
 * Reading a change request template out of a committed git tree, shared by the hosts that have
 * one. Each host package owns its convention (where the template lives, which file wins); this
 * owns the safe read.
 *
 * @module source-control-core/server/changeRequestTemplate
 */
import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "./SourceControlHost.ts";

const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

export type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

export interface TemplateTreeEntry {
  readonly objectId: string;
  readonly path: string;
}

function parseTemplateTreeEntries(output: string): ReadonlyArray<TemplateTreeEntry> {
  const entries: TemplateTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }

    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }

    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    if (
      type !== "blob" ||
      (mode !== "100644" && mode !== "100755") ||
      !objectId ||
      !/^[0-9a-f]{40,64}$/.test(objectId)
    ) {
      continue;
    }

    entries.push({ objectId, path: record.slice(separator + 1) });
  }
  return entries;
}

/**
 * The regular files under `paths` (files or directories) in the committed `treeish`. Worktree
 * paths can be replaced between validation and open, so templates are read from the committed
 * tree: repository-controlled symlinks and path races never reach the host filesystem. None when
 * the listing is too large to trust.
 */
export function listTemplateEntries(input: {
  readonly cwd: string;
  readonly treeish: string;
  readonly executeGit: ExecuteGit;
  readonly operation: string;
  readonly paths: ReadonlyArray<string>;
}): Effect.Effect<Option.Option<ReadonlyArray<TemplateTreeEntry>>, GitCommandError> {
  return input
    .executeGit({
      operation: input.operation,
      cwd: input.cwd,
      args: ["ls-tree", "-r", "-z", "--full-tree", input.treeish, "--", ...input.paths],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) =>
        result.stdoutTruncated
          ? Option.none()
          : Option.some(parseTemplateTreeEntries(result.stdout)),
      ),
    );
}

/** The trimmed, size-capped contents of a template blob. None when it is blank. */
export function readTemplateBlob(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entry: TemplateTreeEntry;
}): Effect.Effect<Option.Option<string>, GitCommandError> {
  return input
    .executeGit({
      operation: "changeRequestTemplate.readTemplateBlob",
      cwd: input.cwd,
      args: ["cat-file", "blob", input.entry.objectId],
      maxOutputBytes: TEMPLATE_MAX_BYTES,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) => {
        const template = result.stdout.trim();
        if (template.length === 0) {
          return Option.none();
        }
        return Option.some(
          result.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
            ? `${template}\n\n${TRUNCATION_MARKER}`
            : template,
        );
      }),
    );
}
