import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { mediaVideoPreviewUri, mediaVideoThumbnailKey } from "../../lib/videoPreviewSource";
import { pullRequestImageSource, pullRequestMediaSource } from "./pullRequestMediaSource";

const location = { environmentId: EnvironmentId.make("test"), cwd: "/repo" };
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps a video resource pending until resolved and accepts refreshed capabilities", () => {
    const source = {
      type: "media" as const,
      name: "Video",
      mimeType: "video/mp4",
      ...pullRequestMediaSource(url, location),
    };
    expect(mediaVideoPreviewUri(source, null)).toBeNull();
    expect(mediaVideoPreviewUri(source, "https://signed/first")).toBe("https://signed/first");
    expect(mediaVideoPreviewUri(source, "https://signed/renewed")).toBe("https://signed/renewed");
    expect(mediaVideoThumbnailKey(source)).toContain("github-media");
  });

  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(gallery.every((item) => "resource" in item)).toBe(true);
  });

  it("loads GitLab uploads through the environment", () => {
    const upload =
      "https://gitlab.example.com/team/app/uploads/66dbcd21ec5d24ed6ea225176098d52b/demo.mp4";
    const source = {
      type: "media" as const,
      name: "Video",
      mimeType: "video/mp4",
      ...pullRequestMediaSource(upload, location),
    };
    expect(source).toMatchObject({ resource: { _tag: "gitlab-media", url: upload } });
    expect(mediaVideoThumbnailKey(source)).toContain("gitlab-media");
  });

  it("leaves custom-domain media as direct URLs", () => {
    const external = "https://drop.example/file.mp4";
    expect(pullRequestMediaSource(external, location)).toEqual({ uri: external });
  });
});
