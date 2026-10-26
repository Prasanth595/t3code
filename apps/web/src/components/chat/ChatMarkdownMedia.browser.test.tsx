import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";

// Every evaluation of the URL query is one mint: the first read, then one per refresh.
const assetQuery = vi.hoisted(() => ({ mints: 0 }));
vi.mock(import("~/state/assets"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const createUrl = Atom.family((_key: string) =>
    Atom.make(() => {
      assetQuery.mints += 1;
      return AsyncResult.success({
        relativeUrl:
          "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }).pipe(Atom.keepAlive),
  );
  const actual = await original();
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target: { readonly input: unknown }) => createUrl(JSON.stringify(target.input)),
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { Option } = await import("effect");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Local",
    httpBaseUrl: "http://localhost:1",
    wsBaseUrl: "ws://localhost:1",
  });
  const prepared: PreparedConnection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  };
  return {
    ...(await original()),
    usePreparedConnection: () => Option.some(prepared),
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

describe("ChatMarkdownAssetImage", () => {
  it("does not re-mint an unchanged workspace image's URL on remount", async () => {
    assetQuery.mints = 0;
    const image = (
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "docs/diagram.png",
        }}
        alt="diagram"
        workspaceMutationId="mutation-1"
      />
    );

    {
      await using screen = await render(image);
      await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    }
    // The first mount at a known revision re-mints the cached URL once.
    expect(assetQuery.mints).toBe(2);

    await using screen = await render(<ChatMarkdownAssetImage {...image.props} />);
    await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    expect(assetQuery.mints).toBe(2);
  });
});

it("keeps image fragments and signs gallery links independently of public thumbnails", async () => {
  const onImageExpand = vi.fn();
  const mediaLocation = { environmentId: EnvironmentId.make("environment-1"), cwd: "/repo" };
  const src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7#icon";
  const { ChatMarkdownImage } = await import("./ChatMarkdownMedia");
  await using screen = await render(
    <div data-image-gallery style={{ display: "flex", gap: 16 }}>
      <ChatMarkdownImage
        src={src}
        style={{ width: 64, height: 64 }}
        alt="first"
        copyMarkdown={undefined}
        standalone={false}
        actionsSource={{ kind: "image", name: "first", src }}
        onImageExpand={onImageExpand}
        mediaLocation={mediaLocation}
      />
      <a href="https://bitbucket.org/acme/web/downloads/full.png#view">
        <ChatMarkdownImage
          src={src}
          style={{ width: 64, height: 64 }}
          alt="thumbnail"
          copyMarkdown={undefined}
          standalone={false}
          actionsSource={{ kind: "image", name: "thumbnail", src }}
          onImageExpand={onImageExpand}
          mediaLocation={mediaLocation}
        />
      </a>
    </div>,
  );
  await screen.getByRole("button", { name: "Preview first" }).click();
  expect(onImageExpand).toHaveBeenCalledOnce();
  expect(onImageExpand.mock.calls[0]?.[0]).toMatchObject({
    index: 0,
    images: [
      { srcFragment: "#icon" },
      {
        srcFragment: "#view",
        actionsSource: {
          asset: {
            environmentId: mediaLocation.environmentId,
            resource: {
              _tag: "github-media",
              cwd: "/repo",
              url: "https://api.bitbucket.org/2.0/repositories/acme/web/downloads/full.png",
            },
          },
        },
      },
    ],
  });
});
