import { RegistryContext } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { resolveFileDiffPath } from "~/lib/diffRendering";

const mocks = vi.hoisted(() => ({ requests: [] as string[] }));

const patchQuery = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return Atom.family((path: string) =>
    Atom.writable(
      (get) => {
        mocks.requests.push(path);
        return AsyncResult.waitingFrom(
          get.self<AsyncResult.AsyncResult<ReviewDiffPreviewSource>>(),
        );
      },
      (get, value: AsyncResult.AsyncResult<ReviewDiffPreviewSource>) => get.setSelf(value),
    ).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
});

vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffFilePatch: (target: { input: { request: { file: { path: string } } } }) =>
      patchQuery(target.input.request.file.path),
  },
}));

import { useReviewFilePatches } from "./useReviewFilePatches";

const source: ReviewDiffPreviewSource = {
  id: "working-tree",
  kind: "working-tree",
  title: "Uncommitted",
  baseRef: null,
  headRef: null,
  diff: "preview",
  diffHash: "hash",
  truncated: true,
  files: ["added.ts", "large.d.ts", "package-lock.json"].map((path) => ({
    path,
    previousPath: null,
    additions: 1,
    deletions: 0,
  })),
};

type HookResult = ReturnType<typeof useReviewFilePatches>;

function Harness(props: {
  revision: string;
  expanded: ReadonlySet<string>;
  onResult: (result: HookResult) => void;
}) {
  const result = useReviewFilePatches({
    environmentId: EnvironmentId.make("test"),
    cwd: "/repo",
    source,
    baseRef: null,
    ignoreWhitespace: false,
    theme: "dark",
    revision: props.revision,
    preview: null,
    isFileExpanded: (file) => props.expanded.has(file.name),
  });
  props.onResult(result);
  return (
    <ul>
      {result.renderableFiles.map((file) => (
        <li key={resolveFileDiffPath(file)}>
          {resolveFileDiffPath(file)} {file.cacheKey?.endsWith(":pending") ? "pending" : file.type}
        </li>
      ))}
    </ul>
  );
}

function setup() {
  mocks.requests = [];
  const registry = AtomRegistry.make();
  const results: HookResult[] = [];
  const ui = (props: { revision?: string; expanded?: ReadonlySet<string> } = {}) => (
    <RegistryContext.Provider value={registry}>
      <Harness
        revision={props.revision ?? "first"}
        expanded={props.expanded ?? new Set()}
        onResult={(result) => results.push(result)}
      />
    </RegistryContext.Provider>
  );
  return {
    ui,
    latest: () => results.at(-1)!,
    complete(path: string, contents = "new") {
      registry.set(
        patchQuery(path),
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${contents}\n`,
          files: source.files!.filter((file) => file.path === path),
          truncated: false,
        }),
      );
    },
  };
}

it("does not request collapsed files", async () => {
  const h = setup();
  await using screen = await render(h.ui(), { router: false });
  await expect.element(screen.getByText("large.d.ts pending")).toBeInTheDocument();
  expect(mocks.requests).toEqual([]);
});

it("loads only the expanded file and keeps its key when its real change type arrives", async () => {
  const h = setup();
  await using screen = await render(h.ui(), { router: false });
  const initialKeys = h.latest().fileKeys;
  const expanded = new Set(["added.ts"]);
  await screen.rerender(h.ui({ expanded }));
  expect(mocks.requests).toEqual(["added.ts"]);
  h.complete("added.ts");
  await expect.element(screen.getByText("added.ts new")).toBeInTheDocument();
  expect(h.latest().fileKeys).toEqual(initialKeys);
});

it("revalidates on reopen without reparsing identical content", async () => {
  const h = setup();
  const expanded = new Set(["added.ts"]);
  {
    await using screen = await render(h.ui({ expanded }), { router: false });
    h.complete("added.ts");
    await expect.element(screen.getByText("added.ts new")).toBeInTheDocument();
  }
  const loaded = h.latest().renderableFiles[0];
  await using screen = await render(h.ui({ expanded }), { router: false });
  expect(mocks.requests).toEqual(["added.ts", "added.ts"]);
  h.complete("added.ts");
  await vi.waitFor(() => expect(h.latest().isPending).toBe(false));
  expect(h.latest().renderableFiles[0]).toBe(loaded);

  await screen.rerender(h.ui({ expanded, revision: "refresh" }));
  h.complete("added.ts", "changed");
  await vi.waitFor(() =>
    expect((h.latest().renderableFiles[0] as FileDiffMetadata | undefined)?.additionLines).toEqual([
      "changed",
    ]),
  );
});
