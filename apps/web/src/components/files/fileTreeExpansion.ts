import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";

export interface FileTreeExpansionModel {
  getItem(path: string): unknown;
}

type DirectoryHandle = {
  isDirectory(): boolean;
  isExpanded(): boolean;
  expand(): void;
  collapse(): void;
};

function asDirectoryHandle(item: unknown): DirectoryHandle | null {
  if (
    typeof item !== "object" ||
    item === null ||
    !("isDirectory" in item) ||
    typeof item.isDirectory !== "function" ||
    !item.isDirectory() ||
    !("isExpanded" in item) ||
    typeof item.isExpanded !== "function" ||
    !("expand" in item) ||
    typeof item.expand !== "function" ||
    !("collapse" in item) ||
    typeof item.collapse !== "function"
  ) {
    return null;
  }
  return item as DirectoryHandle;
}

export function areAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
): boolean {
  return (
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => {
      const item = asDirectoryHandle(model.getItem(path));
      return item !== null && item.isExpanded();
    })
  );
}

export function setAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
  expanded: boolean,
): void {
  for (const path of directoryPaths) {
    const item = asDirectoryHandle(model.getItem(path));
    if (item === null || item.isExpanded() === expanded) continue;
    if (expanded) item.expand();
    else item.collapse();
  }
}

const MAX_PERSISTED_EXPANDED_PATHS = 500;

const ExpandedPathsSchema = Schema.Array(Schema.String);

export function readExpandedPaths(storageKey: string): Set<string> {
  try {
    return new Set(
      boundExpandedPaths(new Set(getLocalStorageItem(storageKey, ExpandedPathsSchema))),
    );
  } catch {
    return new Set();
  }
}

export function writeExpandedPaths(storageKey: string, paths: ReadonlySet<string>): void {
  try {
    if (paths.size === 0) {
      removeLocalStorageItem(storageKey);
      return;
    }
    setLocalStorageItem(storageKey, boundExpandedPaths(paths), ExpandedPathsSchema);
  } catch {
    // Remembering folders is a convenience; a full or blocked storage must not break the tree.
  }
}

function boundExpandedPaths(paths: ReadonlySet<string>): string[] {
  return [...paths]
    .toSorted((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, MAX_PERSISTED_EXPANDED_PATHS);
}

function parentDirectory(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

export function syncPersistedExpansion(args: {
  readonly model: FileTreeExpansionModel;
  readonly directoryPaths: readonly string[];
  readonly loadedDirectories: ReadonlySet<string>;
  readonly persisted: Set<string>;
  readonly pendingRestore: Set<string>;
}): boolean {
  const { model, directoryPaths, loadedDirectories, persisted, pendingRestore } = args;
  const knownDirectories = new Set<string>();
  let changed = false;
  for (const treePath of directoryPaths) {
    const path = treePath.slice(0, -1);
    knownDirectories.add(path);
    const item = asDirectoryHandle(model.getItem(treePath));
    if (item === null) continue;
    if (pendingRestore.has(path)) {
      // Pierre's expand() also opens ancestors; a late listing must not undo a collapse.
      let ancestor = parentDirectory(path);
      while (ancestor && asDirectoryHandle(model.getItem(`${ancestor}/`))?.isExpanded()) {
        ancestor = parentDirectory(ancestor);
      }
      if (ancestor) continue;
      pendingRestore.delete(path);
      if (!item.isExpanded()) item.expand();
    }
    if (item.isExpanded()) {
      if (!persisted.has(path)) {
        persisted.add(path);
        changed = true;
      }
    } else if (persisted.delete(path)) {
      changed = true;
    }
  }
  for (const path of persisted) {
    if (knownDirectories.has(path) || !loadedDirectories.has(parentDirectory(path))) continue;
    persisted.delete(path);
    pendingRestore.delete(path);
    changed = true;
  }
  return changed;
}
