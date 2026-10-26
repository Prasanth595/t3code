import { RegistryContext } from "@effect/atom-react";
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

const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
const firstBatch = paths.slice(0, 4);

const source: ReviewDiffPreviewSource = {
  id: "working-tree",
  kind: "working-tree",
  title: "Uncommitted",
  baseRef: null,
  headRef: null,
  diff: "preview",
  diffHash: "hash",
  truncated: true,
  files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 0 })),
};

type HookResult = ReturnType<typeof useReviewFilePatches>;

function Harness(props: {
  enabled: boolean;
  revision: string;
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
    enabled: props.enabled,
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
  const ui = (props: { enabled?: boolean; revision?: string } = {}) => (
    <RegistryContext.Provider value={registry}>
      <Harness
        enabled={props.enabled ?? true}
        revision={props.revision ?? "first"}
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
          diff: `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+${contents}
`,
          files: source.files!.filter((file) => file.path === path),
          truncated: false,
        }),
      );
    },
  };
}

it("loads nothing until the panel has settled", async () => {
  const h = setup();
  await using screen = await render(h.ui({ enabled: false }), { router: false });
  await expect.element(screen.getByText("a.ts pending")).toBeInTheDocument();
  expect(mocks.requests).toEqual([]);
  await screen.rerender(h.ui());
  expect(mocks.requests).toEqual(firstBatch);
});

it("keeps loaded files and starts no new loads while the panel closes", async () => {
  const h = setup();
  await using screen = await render(h.ui(), { router: false });
  for (const path of firstBatch) h.complete(path);
  await expect.element(screen.getByText("d.ts new")).toBeInTheDocument();
  await screen.rerender(h.ui({ enabled: false }));
  h.latest().loadNextFiles();
  h.latest().requestFile(5);
  await screen.rerender(h.ui({ enabled: false }));
  expect(mocks.requests).toEqual(firstBatch);
  await expect.element(screen.getByText("a.ts new")).toBeInTheDocument();
});

it("revalidates on reopen without reparsing identical content", async () => {
  const h = setup();
  {
    await using screen = await render(h.ui(), { router: false });
    for (const path of firstBatch) h.complete(path);
    await expect.element(screen.getByText("d.ts new")).toBeInTheDocument();
  }
  const loaded = h.latest().renderableFiles[0];
  await using screen = await render(h.ui(), { router: false });
  expect(mocks.requests).toEqual([...firstBatch, ...firstBatch]);
  for (const path of firstBatch) h.complete(path);
  await vi.waitFor(() => expect(h.latest().isPending).toBe(false));
  expect(h.latest().renderableFiles[0]).toBe(loaded);

  await screen.rerender(h.ui({ revision: "refresh" }));
  h.complete("a.ts", "changed");
  await vi.waitFor(() => expect(h.latest().renderableFiles[0]?.additionLines).toEqual(["changed"]));
});
