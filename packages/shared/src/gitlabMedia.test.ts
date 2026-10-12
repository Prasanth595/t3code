import { describe, expect, it } from "vite-plus/test";

import {
  gitlabMediaFetchUrl,
  gitlabMediaFileName,
  gitlabUploadApiUrl,
  parseGitLabUpload,
  resolveGitLabUploadLinks,
} from "./gitlabMedia.ts";

const SECRET = "66dbcd21ec5d24ed6ea225176098d52b";

describe("gitlabMedia", () => {
  it("maps project-path and project-id upload URLs to the upload API", () => {
    const byPath = parseGitLabUpload(
      `https://gitlab.example.com/group/sub/project/uploads/${SECRET}/my%20shot.png`,
    );
    expect(byPath && gitlabUploadApiUrl(byPath)).toBe(
      `https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/uploads/${SECRET}/my%20shot.png`,
    );
    const byId = parseGitLabUpload(
      `https://gitlab.example.com:8443/-/project/42/uploads/${SECRET}/demo.mp4`,
    );
    expect(byId && gitlabUploadApiUrl(byId)).toBe(
      `https://gitlab.example.com:8443/api/v4/projects/42/uploads/${SECRET}/demo.mp4`,
    );
    expect(byId?.host).toBe("gitlab.example.com:8443");
  });

  it("drops query and fragment from the canonical URL", () => {
    expect(
      gitlabMediaFetchUrl(`https://gitlab.com/team/app/uploads/${SECRET}/demo.mp4?x=1#t=2`),
    ).toBe(`https://gitlab.com/team/app/uploads/${SECRET}/demo.mp4`);
  });

  it("rejects anything that is not a project upload over https", () => {
    for (const url of [
      `http://gitlab.com/team/app/uploads/${SECRET}/a.png`,
      `https://user:pw@gitlab.com/team/app/uploads/${SECRET}/a.png`,
      `https://gitlab.com/uploads/${SECRET}/a.png`,
      `https://gitlab.com/team/app/-/uploads/${SECRET}/a.png`,
      `https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png`,
      `https://gitlab.com/team/app/uploads/not-a-secret/a.png`,
      `/uploads/${SECRET}/a.png`,
    ]) {
      expect(gitlabMediaFetchUrl(url), url).toBeNull();
    }
  });

  it("names the file from its decoded last segment", () => {
    expect(gitlabMediaFileName(`https://gitlab.com/a/b/uploads/${SECRET}/my%20shot.png`)).toBe(
      "my shot.png",
    );
    expect(gitlabMediaFileName(`https://gitlab.com/a/b/uploads/${SECRET}/%E0%A4%A.png`)).toBe(
      "%E0%A4%A.png",
    );
  });

  it("resolves the relative upload links GitLab writes into bodies", () => {
    const body = [
      `![shot](/uploads/${SECRET}/shot.png){width=400}`,
      `[demo.mp4](</uploads/${SECRET}/demo.mp4>)`,
      `<img src="/uploads/${SECRET}/inline.png">`,
      `[ref]: /uploads/${SECRET}/ref.pdf`,
      `Prose mentioning /uploads/${SECRET}/x.png stays prose.`,
      `![elsewhere](https://cdn.example.com/uploads/${SECRET}/a.png)`,
    ].join("\n");
    expect(resolveGitLabUploadLinks(body, "https://gitlab.com/team/app/")).toBe(
      [
        `![shot](https://gitlab.com/team/app/uploads/${SECRET}/shot.png){width=400}`,
        `[demo.mp4](<https://gitlab.com/team/app/uploads/${SECRET}/demo.mp4>)`,
        `<img src="https://gitlab.com/team/app/uploads/${SECRET}/inline.png">`,
        `[ref]: https://gitlab.com/team/app/uploads/${SECRET}/ref.pdf`,
        `Prose mentioning /uploads/${SECRET}/x.png stays prose.`,
        `![elsewhere](https://cdn.example.com/uploads/${SECRET}/a.png)`,
      ].join("\n"),
    );
  });
});
