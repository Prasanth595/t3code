import { assert, describe, it } from "@effect/vitest";

import {
  gitHubApiHostForRemote,
  resolveGitHubRepository,
  selectGitHubBaseRepository,
} from "./gitHubRepositoryResolution.ts";

describe("selectGitHubBaseRepository", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries
      .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
      .join("\n");
  const select = (input: { remotes: string; resolved?: string }) =>
    selectGitHubBaseRepository({ resolved: "", host: "github.com", ...input });

  it("picks the repository gh reads without a prompt", () => {
    assert.deepStrictEqual(select({ remotes: remotes(["fork", "git@github.com:me/web.git"]) }), {
      owner: "me",
      name: "web",
    });
    const fork = remotes(
      ["origin", "git@github.com:me/web.git"],
      ["upstream", "https://github.com/Acme/Web.git"],
    );
    assert.deepStrictEqual(select({ remotes: fork }), { owner: "acme", name: "web" });
    assert.deepStrictEqual(select({ remotes: fork, resolved: "remote.origin.gh-resolved base" }), {
      owner: "me",
      name: "web",
    });
    assert.deepStrictEqual(
      select({ remotes: fork, resolved: "remote.origin.gh-resolved acme/other" }),
      { owner: "acme", name: "other" },
    );
    const partialClone = fork.replaceAll("(fetch)", "(fetch) [blob:none]");
    assert.deepStrictEqual(
      select({ remotes: partialClone, resolved: "remote.origin.gh-resolved base" }),
      { owner: "me", name: "web" },
    );
    assert.deepStrictEqual(
      select({
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Upstream", "git@github.com:acme/web.git"],
        ),
      }),
      { owner: "acme", name: "web" },
    );
  });

  it("leaves gh to choose when it might weigh the remotes differently", () => {
    for (const input of [
      { remotes: "" },
      {
        remotes: remotes(["a", "git@github.com:me/web.git"], ["b", "git@github.com:acme/web.git"]),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["mirror", "git@gitlab.com:me/web.git"],
        ),
      },
      { remotes: remotes(["origin", "git@github-work:me/web.git"]) },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Origin", "git@github.com:acme/web.git"],
        ),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["upstream", "git@github.com:acme/web.git"],
        ),
        resolved: "remote.origin.gh-resolved base\nremote.upstream.gh-resolved base",
      },
    ]) {
      assert.strictEqual(select(input), null);
    }
  });
});

describe("gitHubApiHostForRemote", () => {
  it("reads an SSH alias through github.com and a real host as itself", () => {
    assert.strictEqual(gitHubApiHostForRemote("git@github:acme/web.git"), "github.com");
    assert.strictEqual(
      gitHubApiHostForRemote("git@github.example.com:a/b.git"),
      "github.example.com",
    );
    assert.strictEqual(gitHubApiHostForRemote("git@gitlab.com:a/b.git"), null);
  });
});

describe("github.com-<name> SSH aliases", () => {
  it("reads a per-account alias through github.com", () => {
    for (const url of [
      "git@github.com-scale:scalable-so/scalablev2.git",
      "git@GitHub.com-Work:acme/web.git",
      "ssh://git@github.com-personal/acme/web.git",
      "ssh://git@github.com-scale:22/acme/web.git",
    ]) {
      assert.strictEqual(gitHubApiHostForRemote(url), "github.com", url);
    }
  });

  it("never maps a hostile or real DNS host onto github.com", () => {
    for (const [url, host] of [
      ["git@github.com-evil.example:acme/web.git", "github.com-evil.example"],
      ["ssh://git@github.com-evil.example/acme/web.git", "github.com-evil.example"],
      ["git@github.com.evil.example:acme/web.git", "github.com.evil.example"],
      ["git@evil-github.com:acme/web.git", null],
      ["https://github.com-scale/acme/web.git", "github.com-scale"],
    ] as const) {
      assert.strictEqual(gitHubApiHostForRemote(url), host, url);
    }
  });

  it("resolves the API host and repository from an alias remote and its host hint", () => {
    const remotes = [
      "origin\tgit@github.com-scale:scalable-so/scalablev2.git (fetch)",
      "origin\tgit@github.com-scale:scalable-so/scalablev2.git (push)",
    ].join("\n");
    const expected = {
      host: "github.com",
      locator: { host: "github.com", owner: "scalable-so", name: "scalablev2" },
    };
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes,
        resolved: "",
        hostHint: "github.com-scale",
        defaultHost: "github.com-scale",
      }),
      expected,
    );
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes,
        resolved: "",
        hostHint: undefined,
        defaultHost: "github.com",
      }),
      expected,
    );
  });

  it("keeps a hostile host hint and its remote off github.com", () => {
    const remotes = "origin\tgit@github.com-evil.example:acme/web.git (fetch)";
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes,
        resolved: "",
        hostHint: "github.com-evil.example",
        defaultHost: "github.com-evil.example",
      }),
      {
        host: "github.com-evil.example",
        locator: { host: "github.com-evil.example", owner: "acme", name: "web" },
      },
    );
  });
});
