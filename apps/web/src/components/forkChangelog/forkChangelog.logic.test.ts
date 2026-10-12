import { describe, expect, it } from "vite-plus/test";

import { linkCommitSubject } from "./forkChangelog.logic";

describe("linkCommitSubject", () => {
  it("links a pull request number to the repository of the commit", () => {
    expect(linkCommitSubject({ subject: "fix(web): row (#123)", fork: true })).toMatchObject([
      { text: "fix(web): row (", url: null },
      { text: "#123", url: "https://github.com/Yarden-zamir/t3code/pull/123" },
      { text: ")", url: null },
    ]);
    expect(linkCommitSubject({ subject: "#7 and #8", fork: false })).toMatchObject([
      { text: "#7", url: "https://github.com/pingdotgg/t3code/pull/7" },
      { text: " and ", url: null },
      { text: "#8", url: "https://github.com/pingdotgg/t3code/pull/8" },
    ]);
  });

  it("keeps a hash that is not a pull request reference as text", () => {
    for (const subject of ["C#1 support", "owner/name#12", "issue #12a", "heading #", "##"]) {
      expect(linkCommitSubject({ subject, fork: false })).toMatchObject([
        { text: subject, url: null },
      ]);
    }
  });
});
