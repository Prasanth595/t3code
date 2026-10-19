import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopWebLinkTarget } from "./desktopWebLinkTarget";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("effect");
const projects: EnvironmentProject[] = [
  {
    id: projectId,
    environmentId,
    title: "Effect",
    workspaceRoot: "/repo/effect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: {
      provider: "github",
      displayName: "Effect-TS/effect",
      webUrl: "https://github.com/Effect-TS/effect",
      canonicalKey: "github.com/effect-ts/effect",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/Effect-TS/effect.git",
      },
    },
  },
];
const input = {
  projects,
  primaryEnvironmentId: environmentId,
  capabilities: new Map([[environmentId, { pullRequests: true, threadPullRequests: true }]]),
  openPullRequestsInApp: true,
};

describe("external desktop web links", () => {
  it("routes a GitHub PR to the pull request view before opening a browser thread", () => {
    expect(
      resolveDesktopWebLinkTarget({
        ...input,
        url: "https://github.com/Effect-TS/effect/pull/9339",
      }),
    ).toEqual({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository: "effect-ts/effect",
        number: 9339,
        selectedHost: "github.com",
        selectedProjectId: projectId,
        selectedEnvironmentId: environmentId,
      },
    });
  });

  it("leaves ordinary links, unsupported repositories, and opted-out PRs to the browser", () => {
    for (const url of ["https://example.com", "https://github.com/other/repo/pull/1"]) {
      expect(resolveDesktopWebLinkTarget({ ...input, url })).toBeNull();
    }
    const url = "https://github.com/Effect-TS/effect/pull/9339";
    expect(resolveDesktopWebLinkTarget({ ...input, url, openPullRequestsInApp: false })).toBeNull();
    expect(resolveDesktopWebLinkTarget({ ...input, url, capabilities: new Map() })).toBeNull();
  });

  it("keeps prompt links on their existing app route", () => {
    expect(
      resolveDesktopWebLinkTarget({ ...input, url: "https://app.t3.codes/new?prompt=hello" }),
    ).toEqual({ href: "/new?prompt=hello" });
  });
});
