import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { FileTree } from "@pierre/trees";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import {
  readExpandedPaths,
  syncPersistedExpansion,
  writeExpandedPaths,
} from "./fileTreeExpansionStorage";

type FakeDirectoryItem = {
  isDirectory: () => true;
  isExpanded: () => boolean;
  expand: () => void;
  collapse: () => void;
};

function makeModel(expanded: Record<string, boolean>) {
  const items = new Map<string, FakeDirectoryItem>();
  return {
    getItem: (path: string) => {
      const existing = items.get(path);
      if (existing !== undefined) return existing;
      const item: FakeDirectoryItem = {
        isDirectory: () => true,
        isExpanded: () => expanded[path] ?? false,
        expand: () => {
          expanded[path] = true;
        },
        collapse: () => {
          expanded[path] = false;
        },
      };
      items.set(path, item);
      return item;
    },
  };
}

describe("file tree expansion", () => {
  it("requires at least one directory and detects whether all are expanded", () => {
    const model = makeModel({ "src/": true, "test/": true });
    expect(areAllDirectoriesExpanded(model, [])).toBe(false);
    expect(areAllDirectoriesExpanded(model, ["src/", "test/"])).toBe(true);
    expect(
      areAllDirectoriesExpanded(makeModel({ "src/": true, "test/": false }), ["src/", "test/"]),
    ).toBe(false);
  });

  it("expands and collapses every directory", () => {
    const expanded = { "src/": true, "test/": false };
    const model = makeModel(expanded);
    setAllDirectoriesExpanded(model, ["src/", "test/"], true);
    expect(expanded).toEqual({ "src/": true, "test/": true });
    setAllDirectoriesExpanded(model, ["src/", "test/"], false);
    expect(expanded).toEqual({ "src/": false, "test/": false });
  });

  it("skips directories already at the requested state", () => {
    const model = makeModel({ "src/": true });
    const item = model.getItem("src/");
    const collapse = vi.spyOn(item, "collapse");
    setAllDirectoriesExpanded(model, ["src/"], true);
    expect(collapse).not.toHaveBeenCalled();
  });
});

describe("remembered file tree expansion", () => {
  const storageKey = "file-tree-expansion-test";

  afterEach(() => {
    vi.unstubAllGlobals();
    writeExpandedPaths(storageKey, new Set());
  });

  it("only prunes missing folders after their parent was successfully listed", () => {
    const model = new FileTree({ paths: [], initialExpansion: "closed" });
    const persisted = new Set(["src", "src/gone", "src/kept"]);
    const pendingRestore = new Set(persisted);
    const loadedDirectories = new Set<string>();
    const directoryPaths: string[] = [];
    const sync = () =>
      syncPersistedExpansion({
        model,
        directoryPaths,
        loadedDirectories,
        persisted,
        pendingRestore,
      });
    try {
      sync();
      expect(persisted).toEqual(new Set(["src", "src/gone", "src/kept"]));

      model.add("src/");
      directoryPaths.push("src/");
      loadedDirectories.add("");
      sync();
      // An in-flight or failed src listing provides no evidence that its children disappeared.
      sync();
      expect(persisted).toEqual(new Set(["src", "src/gone", "src/kept"]));

      model.add("src/kept/");
      directoryPaths.push("src/kept/");
      loadedDirectories.add("src");
      sync();
      expect(persisted).toEqual(new Set(["src", "src/kept"]));
      expect(pendingRestore.has("src/gone")).toBe(false);
    } finally {
      model.cleanUp();
    }
  });

  it("does not reopen a parent collapsed while its remembered child is still loading", () => {
    const model = new FileTree({ paths: ["src/"], initialExpansion: "closed" });
    const persisted = new Set(["src", "src/components"]);
    const pendingRestore = new Set(persisted);
    const loadedDirectories = new Set([""]);
    const directoryPaths = ["src/"];
    const sync = () =>
      syncPersistedExpansion({
        model,
        directoryPaths,
        loadedDirectories,
        persisted,
        pendingRestore,
      });
    try {
      sync();
      const src = model.getItem("src/");
      if (src === null || !("collapse" in src)) throw new Error("Missing src directory");
      src.collapse();
      sync();
      expect(src.isExpanded()).toBe(false);
      expect(persisted.has("src")).toBe(false);

      model.add("src/components/");
      model.add("src/components/Button.tsx");
      directoryPaths.push("src/components/");
      loadedDirectories.add("src");
      sync();
      expect(src.isExpanded()).toBe(false);
      expect(persisted.has("src")).toBe(false);
    } finally {
      model.cleanUp();
    }
  });

  it("bounds stored folders to 500 while retaining shallow ancestors, and clears a collapsed tree", () => {
    const deep = Array.from({ length: 600 }, (_, index) => `src/components/folder-${index}`);
    writeExpandedPaths(storageKey, new Set([...deep, "src/components", "src"]));
    const restored = readExpandedPaths(storageKey);
    expect(restored.size).toBe(500);
    expect(restored.has("src")).toBe(true);
    expect(restored.has("src/components")).toBe(true);
    expect(
      [...restored].every(
        (path) => path === "src" || path === "src/components" || deep.includes(path),
      ),
    ).toBe(true);

    writeExpandedPaths(storageKey, new Set());
    expect(readExpandedPaths(storageKey)).toEqual(new Set());
  });

  it("treats corrupt or unavailable storage as empty and tolerates failed writes and removals", () => {
    const getItem = vi.fn<() => string | null>();
    const fail = () => {
      throw new Error("Storage unavailable");
    };
    vi.stubGlobal("window", { localStorage: { getItem, setItem: fail, removeItem: fail } });
    for (const value of [null, "{", '"src"', '["src",42]']) {
      getItem.mockReturnValue(value);
      expect(readExpandedPaths(storageKey)).toEqual(new Set());
    }
    getItem.mockImplementation(fail);
    expect(readExpandedPaths(storageKey)).toEqual(new Set());
    expect(() => writeExpandedPaths(storageKey, new Set(["src"]))).not.toThrow();
    expect(() => writeExpandedPaths(storageKey, new Set())).not.toThrow();

    vi.stubGlobal("window", {
      get localStorage() {
        return fail();
      },
    });
    expect(readExpandedPaths(storageKey)).toEqual(new Set());
    expect(() => writeExpandedPaths(storageKey, new Set(["src"]))).not.toThrow();
    expect(() => writeExpandedPaths(storageKey, new Set())).not.toThrow();
  });
});
