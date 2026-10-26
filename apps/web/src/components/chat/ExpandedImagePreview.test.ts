import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildExpandedImagePreview, resolveMarkdownMediaPreview } from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens private PR media links through their environment and retains a renewable resource", async () => {
    const environmentId = EnvironmentId.make("bitbucket-environment");
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({ relativeUrl: "/api/assets/signed/demo.mp4", expiresAt: 1234 }),
    );
    const preview = await resolveMarkdownMediaPreview({
      source: "https://bitbucket.org/acme/web/downloads/demo.mp4#t=2",
      cwd: "/repo",
      environmentId,
      sourceControlMedia: true,
      httpBaseUrl: "https://remote.example",
      createAssetUrl,
    });
    const asset = {
      environmentId,
      resource: {
        _tag: "github-media",
        cwd: "/repo",
        url: "https://api.bitbucket.org/2.0/repositories/acme/web/downloads/demo.mp4",
      },
    };
    expect(createAssetUrl).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { resource: asset.resource },
    });
    expect(preview?.images[0]).toMatchObject({
      type: "video",
      src: "https://remote.example/api/assets/signed/demo.mp4#t=2",
      srcFragment: "#t=2",
      actionsSource: { asset },
    });
  });

  it.each([
    "https://bitbucket.org/acme/web/downloads/demo.mp4?download=1#t=2",
    "https://raw.githubusercontent.com/acme/web/main/demo.mp4#t=2",
  ])("keeps public PR media links usable without signing: %s", async (source) => {
    const unsupported = new Error("Unsupported asset resource: bitbucket-media");
    const createAssetUrl = vi.fn().mockRejectedValue(unsupported);
    const preview = await resolveMarkdownMediaPreview({
      source,
      cwd: "/repo",
      environmentId: EnvironmentId.make("old-server"),
      sourceControlMedia: true,
      httpBaseUrl: "https://remote.example",
      createAssetUrl,
    });
    expect(preview?.images[0]).toMatchObject({
      src: source,
      originalUrl: source,
      type: "video",
    });
    expect(preview?.images[0]?.actionsSource?.asset).toBeUndefined();
  });

  it.each([
    ["t3code:", "https:"],
    ["t3code-dev:", "https:"],
    ["http:", "http:"],
    ["https:", "https:"],
  ])(
    "resolves protocol-relative media on %s without changing its source",
    async (pageProtocol, mediaProtocol) => {
      vi.stubGlobal("window", { location: { protocol: pageProtocol } });
      const source = "//cdn.example.com/recording.mp4?token=a%2FB&v=1#t=2";
      const preview = await resolveMarkdownMediaPreview({
        source,
        createAssetUrl: async () => {
          throw new Error("Remote media must not request a local asset URL.");
        },
      });

      expect(preview?.images[0]).toMatchObject({
        src: `${mediaProtocol}${source}`,
        originalUrl: source,
        actionsSource: {
          src: `${mediaProtocol}${source}`,
          reference: { kind: "url", url: source },
        },
      });
    },
  );
});

describe("buildExpandedImagePreview", () => {
  it("keeps MIME type for stored images without a filename extension", () => {
    const preview = buildExpandedImagePreview(
      [
        {
          type: "image",
          id: "heic-1",
          name: "photo",
          mimeType: "image/heic",
          sizeBytes: 3,
          previewUrl: "blob:heic",
        },
      ],
      "heic-1",
    );
    expect(preview?.images[0]).toMatchObject({
      name: "photo",
      mimeType: "image/heic",
      src: "blob:heic",
    });
  });
});
