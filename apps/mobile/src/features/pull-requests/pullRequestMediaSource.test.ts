import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { pullRequestImageSource } from "./pullRequestMediaSource";

const location = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/different-checkout",
  repositoryUrl: "https://github.com/displayed/repository",
};
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(first).toMatchObject({
      resource: {
        _tag: "github-media",
        url,
        cwd: location.cwd,
        repositoryUrl: location.repositoryUrl,
      },
    });
    expect(gallery.every((item) => "resource" in item)).toBe(true);
  });
});
