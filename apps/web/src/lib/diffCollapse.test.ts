import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useReviewFilePatches } from "../components/diffs/useReviewFilePatches";

import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "./diffCollapse";
import { buildLazyFileDiffIdentityKey } from "./diffRendering";

const { registry, patchAtom } = await vi.hoisted(async () => {
  const Atom = await import("effect/reactivity/Atom");
  const AtomRegistry = await import("effect/reactivity/AtomRegistry");
  const AsyncResult = await import("effect/reactivity/AsyncResult");
  return {
    registry: AtomRegistry.make(),
    patchAtom: Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource>>(AsyncResult.initial()),
  };
});

vi.mock("react", () => ({
  useContext: () => registry,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: <A>(value: A) => ({ current: value }),
  useState: <A>(initialize: () => A) => [initialize(), vi.fn()],
}));
vi.mock("@effect/atom-react", () => ({
  RegistryContext: {},
  useAtomValue: registry.get.bind(registry),
}));
vi.mock("../state/review", () => ({
  reviewEnvironment: { diffFilePatch: () => patchAtom },
}));

afterEach(() => registry.reset());

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toEqual(new Set(FILE_KEYS));
  });

  it("expands all files when every rendered file is collapsed", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set(FILE_KEYS))).toEqual(new Set());
  });

  it.each([
    ["new", ["new file mode 100644", "--- /dev/null", "+++ b/later.ts", "@@ -0,0 +1 @@", "+after"]],
    [
      "deleted",
      ["deleted file mode 100644", "--- a/later.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-before"],
    ],
    ["rename-pure", ["similarity index 100%", "rename from before.ts", "rename to later.ts"]],
    [
      "rename-changed",
      [
        "similarity index 50%",
        "rename from before.ts",
        "rename to later.ts",
        "--- a/before.ts",
        "+++ b/later.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ],
    ],
  ])("preserves bulk and individual collapse choices when a lazy %s file loads", (type, lines) => {
    const previousPath = type.startsWith("rename") ? "before.ts" : null;
    const source: ReviewDiffPreviewSource = {
      id: "working-tree",
      kind: "working-tree",
      title: "Working tree",
      baseRef: null,
      headRef: null,
      diff: "",
      diffHash: type,
      truncated: true,
      files: [{ path: "later.ts", previousPath, additions: 1, deletions: 1 }],
    };
    const readFiles = () =>
      useReviewFilePatches({
        environmentId: EnvironmentId.make("test"),
        cwd: "/repo",
        source,
        baseRef: null,
        ignoreWhitespace: false,
        theme: "light",
        revision: "1",
        preview: null,
      }).renderableFiles;
    const pending = readFiles();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.hunks).toEqual([]);
    const pendingKey = buildLazyFileDiffIdentityKey(pending[0]!);
    const collapsed = toggleAllDiffFiles([FIRST_FILE_KEY, pendingKey], new Set());

    const revealedWhilePending = new Set(collapsed);
    revealedWhilePending.delete(pendingKey);

    registry.set(
      patchAtom,
      AsyncResult.success({
        ...source,
        truncated: false,
        diff: [`diff --git a/${previousPath ?? "later.ts"} b/later.ts`, ...lines, ""].join("\n"),
      }),
    );
    const loaded = readFiles();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.type).toBe(type);
    const loadedKey = buildLazyFileDiffIdentityKey(loaded[0]!);
    const loadedKeys = [FIRST_FILE_KEY, loadedKey];
    expect(revealedWhilePending.has(loadedKey)).toBe(false);
    expect(areAllDiffFilesCollapsed(loadedKeys, collapsed)).toBe(true);
    expect(toggleAllDiffFiles(loadedKeys, collapsed)).toEqual(new Set());

    // Revealing the loaded file must also clear its pending collapse choice.
    const revealed = new Set(collapsed);
    revealed.delete(loadedKey);
    expect(revealed).toEqual(new Set([FIRST_FILE_KEY]));
    expect(revealed.has(pendingKey)).toBe(false);
    expect(toggleAllDiffFiles(loadedKeys, revealed)).toEqual(new Set(loadedKeys));
  });
});
