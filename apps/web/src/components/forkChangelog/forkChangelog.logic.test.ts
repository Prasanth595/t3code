import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  buildForkChangelogAgentTask,
  linkCommitSubject,
  pickForkProject,
} from "./forkChangelog.logic";

describe("linkCommitSubject", () => {
  it("links a pull request number to the repository of the commit", () => {
    expect(linkCommitSubject({ subject: "fix(web): row (#123)", fork: true })).toMatchObject([
      { text: "fix(web): row ", url: null },
      { text: "#123", url: "https://github.com/Yarden-zamir/t3code/pull/123" },
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

describe("pickForkProject", () => {
  const mac = EnvironmentId.make("mac");
  const identity = (canonicalKey: string, originKey?: string) => ({
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: canonicalKey },
    ...(originKey ? { origin: { canonicalKey: originKey } } : {}),
  });

  it("finds a fork checkout that also has an upstream remote, on the asked environment", () => {
    const projects = [
      { name: "other", environmentId: mac, repositoryIdentity: identity("github.com/a/b") },
      {
        name: "vps fork",
        environmentId: EnvironmentId.make("vps"),
        repositoryIdentity: identity("github.com/yarden-zamir/t3code"),
      },
      { name: "no git", environmentId: mac, repositoryIdentity: null },
      {
        name: "mac fork",
        environmentId: mac,
        repositoryIdentity: identity(
          "github.com/pingdotgg/t3code",
          "github.com/yarden-zamir/t3code",
        ),
      },
    ];
    expect(pickForkProject(projects, mac)?.name).toBe("mac fork");
    expect(pickForkProject(projects.slice(0, 1), mac)).toBeNull();
  });
});

describe("buildForkChangelogAgentTask", () => {
  const releases = [
    { tag: "v3", version: "3" },
    { tag: "v2", version: "2" },
    { tag: "v1", version: "1" },
  ];
  const input = { tab: "releases" as const, releases, upstream: null };

  it("names only the releases newer than the installed version", () => {
    const { chip } = buildForkChangelogAgentTask("since-installed", {
      ...input,
      installedVersion: "2",
    });
    expect(chip.text).toContain("newer than the installed version are: `v3`.");
  });

  it("does not guess a range when the installed version is not listed", () => {
    const { chip } = buildForkChangelogAgentTask("since-installed", {
      ...input,
      installedVersion: "0.0.0-dev",
    });
    expect(chip.text).toContain("The installed version is not a listed release.");
    expect(chip.text).not.toContain("newer than the installed version are");
  });
});
