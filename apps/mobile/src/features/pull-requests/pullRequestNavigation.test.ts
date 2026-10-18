import { describe, expect, it } from "vite-plus/test";
import { nativePullRequestDestination } from "../../lib/pullRequestNavigation";
const context = { environmentId: "remote", projectId: "project" };
describe("native PR entry points", () => {
  it("keeps a thread link in its own environment and handles renamed host path shapes", () => {
    expect(
      nativePullRequestDestination("https://github.com/org/repo/pull/12/files#diff", context),
    ).toEqual({ ...context, host: "github.com", repository: "org/repo", number: 12 });
    expect(
      nativePullRequestDestination("https://git.example/group/sub/repo/-/merge_requests/9", context)
        ?.repository,
    ).toBe("group/sub/repo");
    expect(
      nativePullRequestDestination("http://forgejo.test:3000/org/repo/pulls/3", context)?.host,
    ).toBe("forgejo.test:3000");
  });
  it("leaves issues, unknown sites, and unscoped links to the external opener", () => {
    expect(
      nativePullRequestDestination("https://github.com/org/repo/issues/12", context),
    ).toBeNull();
    expect(
      nativePullRequestDestination("https://example.com/org/repo/pull/12", context),
    ).toBeNull();
    expect(nativePullRequestDestination("https://github.com/org/repo/pull/12", null)).toBeNull();
  });
  it("opens a GitHub Enterprise link natively only on a known GitHub host", () => {
    const url = "https://git.corp.example/team/workspace/pull/7";
    expect(nativePullRequestDestination(url, context, ["git.corp.example"])).toEqual({
      ...context,
      host: "git.corp.example",
      repository: "team/workspace",
      number: 7,
    });
    expect(nativePullRequestDestination(url, context)).toBeNull();
  });
});
