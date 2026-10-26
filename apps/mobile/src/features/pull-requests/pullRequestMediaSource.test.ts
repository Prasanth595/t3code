import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { pullRequestMediaSource, pullRequestImageSource } from "./pullRequestMediaSource";

const location = { environmentId: EnvironmentId.make("test"), cwd: "/repo" };
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(gallery.every((item) => "resource" in item)).toBe(true);
  });
});

it("keeps a renewable Bitbucket download with its fallback and fragment", () => {
  expect(
    pullRequestMediaSource("https://bitbucket.org/acme/web/downloads/demo.mp4#t=2", location),
  ).toEqual({
    environmentId: location.environmentId,
    fallbackUri: "https://bitbucket.org/acme/web/downloads/demo.mp4#t=2",
    srcFragment: "#t=2",
    resource: {
      _tag: "github-media",
      cwd: "/repo",
      url: "https://api.bitbucket.org/2.0/repositories/acme/web/downloads/demo.mp4",
    },
  });
});
