import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestQuery } from "./pullRequestList.logic";
import {
  readPullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";
import {
  NO_PULL_REQUEST_OWNER_FILTER,
  projectsOfOwners,
  pullRequestMenuOwnerFilter,
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
    expect(parsed.owners).toEqual({ include: ["qlik-trial", "yarden-zamir"], exclude: [] });
    expect(parsed.filters).toEqual({ labels: [["bug"]] });
    expect(parsed.text).toBe("fix");
  });

  it("reads a comma list as more owners, once each", () => {
    expect(parsePullRequestQuery("owner:a,B org:b", owners).owners?.include).toEqual(["a", "b"]);
  });

  it("reads a negated owner qualifier as an owner to drop", () => {
    const parsed = parsePullRequestQuery("-org:Qlik-Trial,a org:b", owners);
    expect(parsed.owners).toEqual({ include: ["b"], exclude: ["qlik-trial", "a"] });
    expect(parsed.text).toBe("");
  });

  it("keeps an empty owner qualifier as text", () => {
    const parsed = parsePullRequestQuery("owner: -org:", owners);
    expect(parsed.owners).toBeUndefined();
    expect(parsed.filters).toEqual({});
    expect(parsed.text).toBe("owner: -org:");
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

  const ids = (owners: ReadonlyArray<string>, operator: "is" | "is_not") =>
    projectsOfOwners(projects, pullRequestMenuOwnerFilter(owners, operator)).map(({ id }) => id);

  it("keeps every project, as the same array, when no owner is selected", () => {
    expect(projectsOfOwners(projects, NO_PULL_REQUEST_OWNER_FILTER)).toBe(projects);
    expect(projectsOfOwners(projects, pullRequestMenuOwnerFilter([], "is_not"))).toBe(projects);
  });

  it("keeps the projects of the selected owners without case, and drops one without a repository", () => {
    expect(ids(["Yarden-Zamir"], "is")).toEqual(["dotfiles", "t3code"]);
    expect(ids(["qlik-trial", "nobody"], "is")).toEqual(["app"]);
  });

  it("hides the projects of the selected owners, and keeps one without a repository", () => {
    expect(ids(["Qlik-Trial"], "is_not")).toEqual(["dotfiles", "t3code", "scratch"]);
  });

  it("applies typed owners to keep and owners to drop together", () => {
    const keep = (include: string[], exclude: string[]) =>
      projectsOfOwners(projects, { include, exclude }).map(({ id }) => id);
    expect(keep(["yarden-zamir", "qlik-trial"], ["qlik-trial"])).toEqual(["dotfiles", "t3code"]);
    expect(keep(["qlik-trial"], ["qlik-trial"])).toEqual([]);
  });
});

describe("narrowing listed rows by repository owner", () => {
  it("skips the pass when no owner is selected", () => {
    expect(pullRequestOwnerRowFilter([app], NO_PULL_REQUEST_OWNER_FILTER)).toBeNull();
  });

  it("matches a row by its server and project, so a shared project id stays apart", () => {
    const sameIdOnServer = project("app", "github.com/someone-else/app", server);
    const keep = pullRequestOwnerRowFilter(
      [app, sameIdOnServer],
      pullRequestMenuOwnerFilter(["qlik-trial"], "is"),
    );
    expect(keep?.({ environmentId: laptop, projectId: app.id })).toBe(true);
    expect(keep?.({ environmentId: server, projectId: app.id })).toBe(false);
  });

  it("keeps a row of an unknown project only while the filter hides owners", () => {
    const row = { environmentId: server, projectId: ProjectId.make("not-loaded") };
    const hide = pullRequestOwnerRowFilter(
      [app],
      pullRequestMenuOwnerFilter(["qlik-trial"], "is_not"),
    );
    const show = pullRequestOwnerRowFilter([app], pullRequestMenuOwnerFilter(["qlik-trial"], "is"));
    expect(hide?.(row)).toBe(true);
    expect(show?.(row)).toBe(false);
  });
});

describe("remembered owner selection", () => {
  it("restores the selected owners and the hide operator", () => {
    const held = new Map<string, string>();
    const storage = {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
    const preferences = {
      involvement: "all",
      state: "open",
      owners: ["qlik-trial", "yarden-zamir"],
      ownerOperator: "is_not",
    } as const;

    writePullRequestListPreferences(preferences, storage);
    expect(readPullRequestListPreferences(storage)).toEqual(preferences);
  });
});
