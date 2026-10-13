import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestQuery } from "./pullRequestList.logic";
import {
  readPullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";
import {
  projectsOfOwners,
  pullRequestOwnerRowFilter,
  pullRequestProjectOwners,
} from "./pullRequestOwnerFilter.logic";

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");
const locator = { source: "git-remote" as const, remoteName: "origin", remoteUrl: "x" };

function project(
  id: string,
  canonicalKey: string | null,
  environmentId = laptop,
  originKey?: string,
) {
  return {
    id: ProjectId.make(id),
    environmentId,
    repositoryIdentity:
      canonicalKey === null
        ? null
        : {
            canonicalKey,
            locator,
            ...(originKey === undefined ? {} : { origin: { canonicalKey: originKey } }),
          },
  };
}

const app = project("app", "github.com/qlik-trial/app");
const dotfiles = project("dotfiles", "github.com/yarden-zamir/dotfiles");
// A fork of an upstream repository counts as the fork owner's project.
const fork = project(
  "t3code",
  "github.com/pingdotgg/t3code",
  laptop,
  "github.com/Yarden-Zamir/t3code",
);
const scratch = project("scratch", null);

describe("owner qualifiers typed as a search", () => {
  const owners = { ownerQualifiers: true };

  it("reads org and owner as repository owners, lowercase, and keeps the rest", () => {
    const parsed = parsePullRequestQuery("org:Qlik-Trial owner:yarden-zamir label:bug fix", owners);
    expect(parsed.owners).toEqual(["qlik-trial", "yarden-zamir"]);
    expect(parsed.filters).toEqual({ labels: [["bug"]] });
    expect(parsed.text).toBe("fix");
  });

  it("reads a comma list as more owners, once each", () => {
    expect(parsePullRequestQuery("owner:a,B org:b", owners).owners).toEqual(["a", "b"]);
  });

  it("keeps a negated or empty owner qualifier as text", () => {
    const parsed = parsePullRequestQuery("-owner:a owner:", owners);
    expect(parsed.owners).toBeUndefined();
    expect(parsed.filters).toEqual({});
    expect(parsed.text).toBe("-owner:a owner:");
  });

  it("leaves owners out when nothing names one", () => {
    expect(parsePullRequestQuery("label:bug", owners)).toEqual({
      text: "",
      filters: { labels: [["bug"]] },
    });
  });

  it("reads them as namespaced labels while the setting is off", () => {
    const parsed = parsePullRequestQuery("org:qlik-trial owner:a");
    expect(parsed.owners).toBeUndefined();
    expect(parsed.filters.labels).toEqual([["org:qlik-trial"], ["owner:a"]]);
  });
});

describe("narrowing projects by repository owner", () => {
  const projects = [app, dotfiles, fork, scratch];

  it("lists each owner once, sorted and lowercase", () => {
    expect(
      pullRequestProjectOwners([...projects, project("other", "github.com/qlik-trial/x")]),
    ).toEqual(["qlik-trial", "yarden-zamir"]);
  });

  it("keeps every project, as the same array, when no owner is selected", () => {
    expect(projectsOfOwners(projects, [])).toBe(projects);
  });

  it("keeps the projects of the selected owners without case, and drops one without a repository", () => {
    expect(projectsOfOwners(projects, ["Yarden-Zamir"]).map(({ id }) => id)).toEqual([
      "dotfiles",
      "t3code",
    ]);
    expect(projectsOfOwners(projects, ["qlik-trial", "nobody"]).map(({ id }) => id)).toEqual([
      "app",
    ]);
  });
});

describe("narrowing listed rows by repository owner", () => {
  it("skips the pass when no owner is selected", () => {
    expect(pullRequestOwnerRowFilter([app], [])).toBeNull();
  });

  it("matches a row by its server and project, so a shared project id stays apart", () => {
    const sameIdOnServer = project("app", "github.com/someone-else/app", server);
    const keep = pullRequestOwnerRowFilter([app, sameIdOnServer], ["qlik-trial"]);
    expect(keep?.({ environmentId: laptop, projectId: app.id })).toBe(true);
    expect(keep?.({ environmentId: server, projectId: app.id })).toBe(false);
  });
});

describe("remembered owner selection", () => {
  it("restores the selected owners", () => {
    const held = new Map<string, string>();
    const storage = {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
    const preferences = {
      involvement: "all",
      state: "open",
      owners: ["qlik-trial", "yarden-zamir"],
    } as const;

    writePullRequestListPreferences(preferences, storage);
    expect(readPullRequestListPreferences(storage)).toEqual(preferences);
  });
});
