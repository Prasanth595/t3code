import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => mint) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
  usePreparedConnection: (() => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  })) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ relativeUrl: "/api/assets/updated.svg", expiresAt: 1 }),
    );
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("opens host media through server authorization before the client grant loads", async () => {
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ChatMarkdown
        cwd="/repo"
        threadRef={{
          environmentId: EnvironmentId.make("media-environment"),
          threadId: ThreadId.make("media-thread"),
        }}
        text="[Open image](/tmp/image.png)"
        onImageExpand={onImageExpand}
      />,
    ),
  );
  const link = container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    ),
  );
});

const threadRef = {
  environmentId: EnvironmentId.make("media-environment"),
  threadId: ThreadId.make("media-thread"),
};

it.each([
  { name: "a file preview refreshes", mutations: ["m1", "m2", "m2"], calls: [1, 2, 2] },
  { name: "ordinary chat never refreshes", mutations: [undefined, undefined], calls: [0, 0] },
])("$name an embedded host asset as the workspace changes", async ({ mutations, calls }) => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  for (const [index, workspaceMutationId] of mutations.entries()) {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd="/repo"
          imageBaseDir="/repo"
          threadRef={threadRef}
          text="![Diagram](diagram.svg)"
          {...(workspaceMutationId === undefined ? {} : { workspaceMutationId })}
        />,
      ),
    );
    expect(mint).toHaveBeenCalledTimes(calls[index]!);
  }
  for (const call of mint.mock.calls) {
    expect(call).toEqual([
      {
        environmentId: threadRef.environmentId,
        input: {
          resource: { _tag: "media-file", threadId: threadRef.threadId, path: "/repo/diagram.svg" },
        },
      },
    ]);
  }
});
