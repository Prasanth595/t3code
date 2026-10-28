// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { transform } from "oxc-transform-react";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { isTemporaryComposerTarget } from "./temporaryChat";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

const webSourceFiles = NodeFS.readdirSync(NodePath.join(repoRoot, "apps/web/src"), {
  recursive: true,
})
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .filter((file) => !file.endsWith(".gen.ts"))
  .map((file) => `apps/web/src/${file}`);

// ChatView is ~9k lines. Compiling it takes ~9s on a fast machine and can pass the
// 15s project limit on loaded CI runners, so slow files get a 60s limit below.
const slowFiles = new Set(["apps/web/src/components/ChatView.tsx"]);

const compile = async (file: string) => {
  const absolute = NodePath.join(repoRoot, file);
  const result = await transform(absolute, NodeFS.readFileSync(absolute, "utf8"), {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  const bailouts = result.errors.map((error) => error.codeframe ?? error.message);
  expect(bailouts).toEqual([]);
  return result.code;
};

it("updates the compiled composer provider gate when a stable draft toggles Temporary", async () => {
  const code = await compile("apps/web/src/components/chat/ChatComposer.tsx");
  const draftPolicy = code.slice(
    code.indexOf("const composerDraft ="),
    code.indexOf("const composerDraftTargetKeyRef ="),
  );
  const providerPolicyStart = code.indexOf("const compatibleRuntimeModeOptions =");
  expect(providerPolicyStart).toBeGreaterThanOrEqual(0);
  const providerPolicy = code.slice(
    code.indexOf("\n", providerPolicyStart),
    code.indexOf("const sendDisabledReason ="),
  );
  const cacheSize = Number(code.match(/_c\((\d+)\)/)?.[1]);
  expect(cacheSize).toBeGreaterThan(0);
  const render = NodeVM.runInNewContext(
    `(composerDraftTarget, selectedProviderEntry, selectedModel) => {
      ${draftPolicy}
      ${providerPolicy}
      return providerSendBlockReason;
    }`,
    {
      $: Array.from({ length: cacheSize }, () => Symbol.for("react.memo_cache_sentinel")),
      useComposerThreadDraft: (target: DraftId) =>
        useComposerDraftStore.getState().getComposerDraft(target),
      useComposerDraftStore: (
        select: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown,
      ) => select(useComposerDraftStore.getState()),
      isTemporaryComposerTarget,
      isTemporaryThread,
      getAntigravitySendBlockReason: () => null,
    },
  ) as (
    target: DraftId,
    provider: { snapshot: { temporaryThreads: boolean } },
    model: string,
  ) => string | null;
  const target = DraftId.make("compiled-temporary-toggle");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(EnvironmentId.make("compiled-env"), ProjectId.make("compiled-project")),
    target,
  );
  onTestFinished(() => store.clearDraftThread(target));
  store.setPrompt(target, "Keep this typed prompt");
  const promptDraft = store.getComposerDraft(target);
  const provider = { snapshot: { temporaryThreads: false } };

  expect(render(target, provider, "model")).toBeNull();
  store.setDraftThreadContext(target, { temporary: true });
  expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(promptDraft);
  expect(render(target, provider, "model")).toBe(
    "This provider cannot run temporary chats. Choose a supported provider or turn off Temporary.",
  );
  store.setDraftThreadContext(target, { temporary: false });
  expect(render(target, provider, "model")).toBeNull();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "Keep this typed prompt",
  );
});

// Lint reports most compiler bailouts, but not every one (try/finally, throw
// inside try). A skipped file still builds, just unmemoized, so check the output.
describe("React Compiler coverage", () => {
  it.each(webSourceFiles.filter((file) => !slowFiles.has(file)))("compiles %s", async (file) => {
    await compile(file);
  });
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- CPU-bound compile of a huge file, not a hidden wait.
  it.each([...slowFiles])(
    "compiles %s",
    async (file) => {
      await compile(file);
    },
    60_000,
  );
});
