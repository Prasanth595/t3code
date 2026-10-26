import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { resolveFileDiffPath } from "~/lib/diffRendering";

const mocks = vi.hoisted(() => ({ requests: [] as string[], parses: [] as string[] }));

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

vi.mock("./parsePatchOffMainThread", async () => {
  const { getRenderablePatch } = await import("~/lib/diffRendering");
  return {
    parsePatchOffMainThread: async (patch: string, scope: string) => {
      mocks.parses.push(patch);
      return getRenderablePatch(patch, scope, { compactPartialHunkOffsets: true });
    },
  };
});

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
  files: [{ path: "a.ts", previousPath: null, additions: 1, deletions: 0 }],
};

type HookResult = ReturnType<typeof useReviewFilePatches>;

function Harness(props: { revision: string; onResult: (result: HookResult) => void }) {
  const result = useReviewFilePatches({
    environmentId: EnvironmentId.make("test"),
    cwd: "/repo",
    source,
    baseRef: null,
    ignoreWhitespace: false,
    theme: "dark",
    revision: props.revision,
    preview: null,
  });
  props.onResult(result);
  return (
    <ul>
      {result.renderableFiles.map((file) => (
        <li key={resolveFileDiffPath(file)}>
          {resolveFileDiffPath(file)} {file.additionLines.join(",") || "pending"}
        </li>
      ))}
    </ul>
  );
}

function setup() {
  mocks.requests = [];
  mocks.parses = [];
  const registry = AtomRegistry.make();
  const results: HookResult[] = [];
  return {
    ui: (revision = "first") => (
      <RegistryContext.Provider value={registry}>
        <Harness revision={revision} onResult={(result) => results.push(result)} />
      </RegistryContext.Provider>
    ),
    latest: () => results.at(-1)!,
    complete(contents: string) {
      registry.set(
        patchQuery("a.ts"),
        AsyncResult.success({
          ...source,
          diff: `diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+${contents}\n`,
          truncated: false,
        }),
      );
    },
  };
}

it("reopening shows the kept parse and revalidates once the preview refreshes", async () => {
  const h = setup();
  {
    await using screen = await render(h.ui(), { router: false });
    h.complete("first");
    await expect.element(screen.getByText("a.ts first")).toBeInTheDocument();
  }
  const parsed = h.latest().renderableFiles[0];
  await using screen = await render(h.ui(), { router: false });
  expect(h.latest().renderableFiles[0]).toBe(parsed);
  expect(mocks.requests).toEqual(["a.ts"]);

  await screen.rerender(h.ui("refreshed"));
  expect(mocks.requests).toEqual(["a.ts", "a.ts"]);
  h.complete("first");
  await vi.waitFor(() => expect(h.latest().isPending).toBe(false));
  expect(h.latest().renderableFiles[0]).toBe(parsed);
  expect(mocks.parses).toHaveLength(1);

  await screen.rerender(h.ui("changed"));
  h.complete("changed");
  await expect.element(screen.getByText("a.ts changed")).toBeInTheDocument();
  expect(mocks.parses).toHaveLength(2);
});
