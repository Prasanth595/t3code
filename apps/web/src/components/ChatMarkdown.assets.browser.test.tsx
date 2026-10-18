import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AssetUrlState } from "../assets/assetUrls";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
const asset = vi.hoisted(() => ({
  state: { _tag: "Loading" } as AssetUrlState,
  connected: true,
  listeners: new Set<() => void>(),
}));
vi.mock(import("../assets/assetUrls"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useAssetUrlState: () =>
      useSyncExternalStore(
        (listener) => {
          asset.listeners.add(listener);
          return () => {
            asset.listeners.delete(listener);
          };
        },
        () => asset.state,
      ),
  };
});
vi.mock(import("./media/MediaActions"), async (original) => ({
  ...(await original()),
  MediaActions: () => <></>,
}));
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
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readEnvironmentScope: () => false,
    useEnvironmentScope: () => false,
    readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
    usePreparedConnection: (() => {
      const connected = useSyncExternalStore(
        (listener) => {
          asset.listeners.add(listener);
          return () => {
            asset.listeners.delete(listener);
          };
        },
        () => asset.connected,
      );
      return connected
        ? { _tag: "Some", value: { httpBaseUrl: "https://host.test" } }
        : { _tag: "None" };
    }) as never,
  };
});

import ChatMarkdown, { ChatMarkdownAssetImage } from "./ChatMarkdown";

const assetProps = {
  environmentId: EnvironmentId.make("media-environment"),
  resource: {
    _tag: "media-file",
    threadId: ThreadId.make("media-thread"),
    path: "/repo/diagram.svg",
  },
  alt: "Diagram",
} satisfies ComponentProps<typeof ChatMarkdownAssetImage>;

const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  asset.state = { _tag: "Loading" };
  asset.connected = true;
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

function createTestRoot() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  return root;
}

async function publishAssetState(state: AssetUrlState) {
  await act(async () => {
    asset.state = state;
    for (const listener of asset.listeners) listener();
  });
}

async function setConnected(connected: boolean) {
  await act(async () => {
    asset.connected = connected;
    for (const listener of asset.listeners) listener();
  });
}

it.each(["opened", "edited"] as const)(
  "refreshes a cached failure after a file preview is %s offline and reconnects",
  async (action) => {
    asset.state = { _tag: "Failure" };
    asset.connected = action === "edited";
    const root = createTestRoot();
    await act(async () => {
      root.render(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId={null} />);
    });
    if (action === "edited") {
      await setConnected(false);
      mint.mockClear();
      for (const mutation of ["edit-1", "edit-2"]) {
        await act(async () => {
          root.render(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId={mutation} />);
        });
      }
    }
    expect(mint).not.toHaveBeenCalled();
    await setConnected(true);
    expect(mint).toHaveBeenCalledExactlyOnceWith({
      environmentId: assetProps.environmentId,
      input: { resource: assetProps.resource },
    });
  },
);

it("does not mint a second URL when the initial file preview request completes", async () => {
  const root = createTestRoot();
  await act(async () => {
    root.render(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId="initial" />);
  });
  await publishAssetState({
    _tag: "Success",
    url: "https://host.test/diagram.svg",
    expiresAt: 1,
  });
  expect(mint).not.toHaveBeenCalled();
});

it.each(
  (["Loading", "Success", "Failure"] as const).flatMap((initial) =>
    (["Success", "Failure"] as const).map((outcome) => [initial, outcome] as const),
  ),
)(
  "refreshes a file changed during a pending %s request after it ends in %s",
  async (initial, outcome) => {
    asset.state =
      initial === "Success"
        ? { _tag: "Success", url: "https://host.test/stale.svg", expiresAt: 1, waiting: true }
        : { _tag: initial, waiting: true };
    const root = createTestRoot();
    await act(async () => {
      root.render(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId="initial" />);
    });
    for (const mutation of ["edit-1", "edit-2"]) {
      await act(async () => {
        root.render(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId={mutation} />);
      });
    }
    expect(mint).not.toHaveBeenCalled();
    await publishAssetState(
      outcome === "Failure"
        ? { _tag: "Failure" }
        : { _tag: "Success", url: "https://host.test/stale.svg", expiresAt: 1 },
    );
    expect(mint).toHaveBeenCalledExactlyOnceWith({
      environmentId: assetProps.environmentId,
      input: { resource: assetProps.resource },
    });
    await act(async () => {
      root.render(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId="edit-2" />);
    });
    expect(mint).toHaveBeenCalledTimes(1);
  },
);

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
