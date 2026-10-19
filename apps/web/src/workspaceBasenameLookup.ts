import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

function slashPath(path: string): string {
  return path.trim().replaceAll("\\", "/");
}

function pickWorkspaceSuffixMatch(
  relativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = slashPath(relativePath);
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const matching = (fold: (path: string) => string) => {
    const suffix = fold(target);
    return files.filter((entry) => {
      const path = fold(slashPath(entry.path));
      return path === suffix || path.endsWith(`/${suffix}`);
    });
  };
  const exact = matching((path) => path);
  const matches = exact.length > 0 ? exact : matching((path) => path.toLowerCase());
  return matches.length === 1 ? (matches[0]?.path ?? null) : null;
}

export async function findWorkspaceFileMatch(
  relativePath: string,
  lookup: {
    readonly cwd?: string;
    /** False only when the literal file is known to be missing. */
    readonly literalExists: () => Promise<boolean>;
    /** Indexed candidates for the query, or null when the search failed. */
    readonly searchFiles: (query: string) => Promise<{
      readonly entries: ReadonlyArray<WorkspaceEntryCandidate>;
      readonly truncated: boolean;
    } | null>;
  },
): Promise<string | null> {
  try {
    if (needsWorkspaceBasenameLookup(relativePath)) {
      const result = await lookup.searchFiles(relativePath);
      return result ? pickWorkspaceBasenameMatch(relativePath, result.entries) : null;
    }
    if (!/[\\/]/.test(relativePath) || (await lookup.literalExists()) !== false) return null;
    const query = slashPath(relativePath).replace(/^(?:\.\/)+/, "");
    const strippedPath = lookup.cwd ? stripRepeatedWorkspacePrefix(query, lookup.cwd) : null;
    if (strippedPath !== null && lookup.cwd) {
      const strippedResult = await lookup.searchFiles(strippedPath);
      const match = strippedResult
        ? pickStrippedWorkspaceMatch(strippedPath, lookup.cwd, strippedResult.entries)
        : null;
      // This exact target does not depend on suffix uniqueness or a complete index.
      if (match !== null) return match;
    }
    const result = await lookup.searchFiles(query);
    // Truncation also covers an incomplete index scan, so uniqueness is unknown.
    return result && !result.truncated ? pickWorkspaceSuffixMatch(query, result.entries) : null;
  } catch {
    return null;
  }
}

// Repository-relative paths can repeat the project's suffix in subfolder projects.
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

export function pickStrippedWorkspaceMatch(
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  const key = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const files = entries.filter((entry) => entry.kind === "file");
  return files.find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}
