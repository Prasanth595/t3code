import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { structuredPatch } from "diff";

import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

/**
 * Azure hangs a pull request's changed files off an iteration, so a push landing mid-read would
 * renumber the list under a cursor that did not also pin the iteration.
 */
export interface AzureDevOpsDiffCursor {
  readonly iterationId: number;
  readonly fileIndex: number;
}

const CURSOR_SEPARATOR = ":";

/**
 * Restricts each half to plain decimal, so `Number` cannot read a foreign cursor's `0x3` as
 * three.
 */
const CURSOR_COMPONENT = /^\d+$/;

export function formatAzureDevOpsDiffCursor(cursor: AzureDevOpsDiffCursor): string {
  return `${cursor.iterationId}${CURSOR_SEPARATOR}${cursor.fileIndex}`;
}

export function parseAzureDevOpsDiffCursor(
  raw: string | null | undefined,
): AzureDevOpsDiffCursor | null {
  if (raw === null || raw === undefined) return null;
  const [iteration, file, ...rest] = raw.split(CURSOR_SEPARATOR);
  if (rest.length > 0) return null;
  if (iteration === undefined || file === undefined) return null;
  if (!CURSOR_COMPONENT.test(iteration) || !CURSOR_COMPONENT.test(file)) return null;
  const iterationId = Number(iteration);
  const fileIndex = Number(file);
  if (!Number.isSafeInteger(iterationId) || iterationId <= 0) return null;
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return null;
  return { iterationId, fileIndex };
}

export interface AzureDevOpsFileTexts {
  readonly oldContents: string;
  readonly newContents: string;
  /** Azure's own flag for a file it hands back base64-encoded instead of as text. */
  readonly binary: boolean;
}

export interface AzureDevOpsFilePatch {
  readonly section: string;
  /** The file changed but its hunks are not in the section, so the patch has a hole in it. */
  readonly truncated: boolean;
  /**
   * The diff was given up on partway, having spent the whole edit budget, so a caller reading a
   * run of files stops here rather than paying that again for each one behind it.
   */
  readonly abandoned: boolean;
  /**
   * Lines added or removed, which is the edit distance the diff had to search out, and what a
   * slice's budget is spent in: a file of short lines is cheap on the wire and dear to diff.
   */
  readonly edits: number;
}

/**
 * Azure hands back whole files rather than a patch, so an oversize file is paid for twice
 * over before anything can be diffed.
 */
const MAX_FILE_BYTES = 512 * 1024;

const PATCH_CONTEXT_LINES = 3;

/**
 * The line diff costs about the square of the edit distance, so an unbounded pair sharing almost
 * nothing could hold the whole server. Bounded in edits rather than milliseconds so a change
 * slices the same way on every machine.
 */
export const MAX_FILE_DIFF_EDITS = 2_000;

/**
 * The ceiling rather than this is what decides a patch's shape: a timeout that fires would slice
 * the same change one way here and another on a busier host.
 */
const MAX_FILE_DIFF_MILLIS = 2_000;

export const MAX_DIFF_SLICE_EDITS = 6_000;

export const MAX_DIFF_SLICE_BYTES = 256 * 1024;

/**
 * A binary, oversize, or unreadable entry is just a header, so neither budget above stops a
 * run of thousands of them.
 */
export const MAX_DIFF_SLICE_FILES = 300;

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function contentLines(contents: string): ReadonlyArray<string> {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A NUL byte is git's own test for it, and it survives Azure's JSON envelope intact. */
function isBinary(contents: string): boolean {
  return contents.includes("\u0000");
}

export const byteLength = (contents: string) => Buffer.byteLength(contents, "utf8");

/**
 * Git points an empty range at the line before it, which is line zero for a file that is wholly
 * new or wholly gone, and writes a single line as its number alone.
 */
function hunkRange(start: number, lines: number): string {
  if (lines === 0) return `${start - 1},0`;
  return lines === 1 ? String(start) : `${start},${lines}`;
}

/**
 * Azure reports no file mode, so the ordinary one stands in. Names are quoted the way git quotes
 * them, prefix inside the quoting: a header reader stops a bare name at its first tab or newline,
 * so a path holding either would be truncated and its viewed mark would land on the wrong file.
 */
function patchHeader(change: AzureDevOpsChangeEntry): string {
  const oldSide = quoteGitPatchPath(`a/${change.oldPath}`);
  const newSide = quoteGitPatchPath(`b/${change.path}`);
  const lines = [`diff --git ${oldSide} ${newSide}`];
  if (change.changeKind === "new") lines.push("new file mode 100644");
  if (change.changeKind === "deleted") lines.push("deleted file mode 100644");
  if (change.changeKind === "rename-pure" || change.changeKind === "rename-changed") {
    lines.push(
      `rename from ${quoteGitPatchPath(change.oldPath)}`,
      `rename to ${quoteGitPatchPath(change.path)}`,
    );
  }
  lines.push(
    `--- ${change.changeKind === "new" ? "/dev/null" : oldSide}`,
    `+++ ${change.changeKind === "deleted" ? "/dev/null" : newSide}`,
  );
  return lines.join("\n");
}

function replacementSection(header: string, texts: AzureDevOpsFileTexts): string {
  const oldLines = contentLines(texts.oldContents);
  const newLines = contentLines(texts.newContents);
  const noNewline = (contents: string, lines: ReadonlyArray<string>) =>
    lines.length > 0 && !contents.endsWith("\n") ? [NO_NEWLINE_MARKER] : [];
  return [
    header,
    `@@ -${hunkRange(1, oldLines.length)} +${hunkRange(1, newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...noNewline(texts.oldContents, oldLines),
    ...newLines.map((line) => `+${line}`),
    ...noNewline(texts.newContents, newLines),
    "",
  ].join("\n");
}

/**
 * One file's section of a unified patch, built here because Azure has no route that returns one:
 * its diff routes name the files that changed, and the contents are a separate read per side.
 */
export function azureDevOpsFilePatch(input: {
  readonly change: AzureDevOpsChangeEntry;
  readonly texts: AzureDevOpsFileTexts;
}): AzureDevOpsFilePatch {
  const header = patchHeader(input.change);
  const { oldContents, newContents } = input.texts;

  if (input.texts.binary || isBinary(oldContents) || isBinary(newContents)) {
    const oldSide = quoteGitPatchPath(`a/${input.change.oldPath}`);
    const newSide = quoteGitPatchPath(`b/${input.change.path}`);
    const binary = `Binary files ${oldSide} and ${newSide} differ`;
    return { section: `${header}\n${binary}\n`, truncated: true, abandoned: false, edits: 0 };
  }
  if (byteLength(oldContents) > MAX_FILE_BYTES || byteLength(newContents) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false, edits: 0 };
  }

  // A creation or deletion has nothing on one side, so writing both sides in full is already the
  // minimal patch and needs no diff search.
  const created = oldContents === "" && newContents !== "";
  const deleted = newContents === "" && oldContents !== "";
  if (created || deleted) {
    const contents = created ? newContents : oldContents;
    const lines = contentLines(contents);
    // A `+`/`-` marker on every line can put a side that just fits the size ceiling over it.
    // Checked against bytes-plus-marker-count rather than building the section, since that upper
    // bound is cheaper and this is exactly the file shape that would cost the most to build.
    if (byteLength(contents) + lines.length > MAX_FILE_BYTES) {
      return { section: `${header}\n`, truncated: true, abandoned: false, edits: lines.length };
    }
    const section = replacementSection(header, input.texts);
    if (byteLength(section) > MAX_FILE_BYTES) {
      return { section: `${header}\n`, truncated: true, abandoned: false, edits: lines.length };
    }
    return { section, truncated: false, abandoned: false, edits: lines.length };
  }

  const patch = structuredPatch(
    `a/${input.change.oldPath}`,
    `b/${input.change.path}`,
    oldContents,
    newContents,
    undefined,
    undefined,
    {
      context: PATCH_CONTEXT_LINES,
      maxEditLength: MAX_FILE_DIFF_EDITS,
      timeout: MAX_FILE_DIFF_MILLIS,
    },
  );
  // Hitting the edit ceiling lists the file without hunks rather than falling back to a full
  // replacement: the ceiling is a distance, not a proportion, so a long file can reach it having
  // changed in one small corner, and both sides in full would bury that corner in a wall of text.
  if (patch === undefined) {
    return {
      section: `${header}\n`,
      truncated: true,
      abandoned: true,
      edits: MAX_FILE_DIFF_EDITS,
    };
  }

  let edits = 0;
  const hunks = patch.hunks.map((hunk) => {
    for (const line of hunk.lines) {
      if (line.startsWith("+") || line.startsWith("-")) edits += 1;
    }
    return [
      `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    ].join("\n");
  });
  const section = hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.join("\n")}\n`;
  // The edit ceiling bounds edit distance, not the hunks' size: a handful of very long lines plus
  // context can still exceed the size ceiling even well inside the edit ceiling.
  if (byteLength(section) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false, edits };
  }
  return { section, truncated: false, abandoned: false, edits };
}

export function azureDevOpsUnreadableFilePatch(
  change: AzureDevOpsChangeEntry,
): AzureDevOpsFilePatch {
  return { section: `${patchHeader(change)}\n`, truncated: true, abandoned: false, edits: 0 };
}
