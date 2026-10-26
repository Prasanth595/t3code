import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { buildHomeProjectScopes, type HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  listedProjectKey,
  newTaskDestination,
  orderSuggestedProjectFirst,
  pickerProjectScopes,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(
  projects: ReadonlyArray<EnvironmentProject>,
  key = "github.com/t3tools/t3code",
): HomeProjectScope {
  return {
    key,
    title: key,
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("resolveDraftProjectSelection", () => {
  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("newTaskDestination", () => {
  const projects = [makeProject("first"), makeProject("current", "other-environment")];
  const scopes = projects.map((project) => makeScope([project], project.id));

  it("asks for a project before opening a draft, listing the current project first", () => {
    const destination = newTaskDestination(scopes, "other-environment:current", "request");
    expect(destination).toEqual({
      kind: "pick",
      picker: { requestId: "request", suggestedProjectKey: "other-environment:current" },
    });
    expect(
      orderSuggestedProjectFirst(scopes, "other-environment:current").map((scope) => scope.key),
    ).toEqual(["current", "first"]);
  });

  it("asks for a project in the existing order with nothing open", () => {
    expect(newTaskDestination(scopes, undefined, "request")).toEqual({
      kind: "pick",
      picker: { requestId: "request" },
    });
    expect(orderSuggestedProjectFirst(scopes, undefined)).toEqual(scopes);
  });

  it("opens the draft directly in the only selectable project", () => {
    const only = makeProject("only");
    expect(newTaskDestination([makeScope([only])], undefined, "request")).toEqual({
      kind: "draft",
      draft: { requestId: "request", environmentId: "environment", projectId: "only" },
    });
  });

  it("counts only the projects the picker lists, not projectless threads", () => {
    const real = makeScope([makeProject("only")], "only");
    const scratch = makeScope([
      makeProject("scratch", "environment", { workspaceRoot: "/scratch" }),
    ]);
    const serverConfigs = new Map([
      [EnvironmentId.make("environment"), { scratchWorkspaceRoot: "/scratch" }],
    ]);
    expect(
      newTaskDestination(pickerProjectScopes([real, scratch], serverConfigs), undefined, "request"),
    ).toEqual({
      kind: "draft",
      draft: { requestId: "request", environmentId: "environment", projectId: "only" },
    });
    // With no real project the picker still opens, offering "No project" and Add project.
    expect(
      newTaskDestination(pickerProjectScopes([scratch], serverConfigs), undefined, "request"),
    ).toEqual({ kind: "pick", picker: { requestId: "request" } });
  });

  it("keeps the current workspace when the only project spans environments", () => {
    const scope = makeScope([makeProject("t3code", "mac"), makeProject("t3code", "server")]);
    expect(newTaskDestination([scope], "server:t3code", "request")).toEqual({
      kind: "draft",
      draft: { requestId: "request", environmentId: "server", projectId: "t3code" },
    });
    expect(newTaskDestination([scope], undefined, "request")).toEqual({
      kind: "draft",
      draft: { requestId: "request", environmentId: "mac", projectId: "t3code" },
    });
  });

  it("keeps the current project's workspace when its scope is picked", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const scope = makeScope([mac, server]);
    expect(orderSuggestedProjectFirst([scopes[0]!, scope], "server:t3code")[0]).toBe(scope);
    expect(getProjectScopeSelectionTarget(scope, EnvironmentId.make("mac"), "server:t3code")).toBe(
      server,
    );
  });

  it("resolves a thread's older registration to the one listed at the same path", () => {
    const repository = { repositoryKey: "github.com/t3tools/t3code" };
    const mac = makeProject("mac-t3code", "mac", { ...repository, workspaceRoot: "/mac/t3code" });
    const older = {
      ...makeProject("server-old", "server", { ...repository, workspaceRoot: "/srv/t3code" }),
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const newer = makeProject("server-new", "server", {
      ...repository,
      workspaceRoot: "/srv/t3code",
    });
    const projects = [mac, older, newer];
    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });
    expect(scopes.map((scope) => scope.representative)).toEqual([mac]);

    const currentProjectKey = listedProjectKey(scopes, projects, "server:server-old");
    expect(currentProjectKey).toBe("server:server-new");
    expect(newTaskDestination(scopes, currentProjectKey, "request")).toEqual({
      kind: "draft",
      draft: { requestId: "request", environmentId: "server", projectId: "server-new" },
    });
    expect(listedProjectKey(scopes, projects, "mac:mac-t3code")).toBe("mac:mac-t3code");
    expect(listedProjectKey(scopes, projects, undefined)).toBeUndefined();
  });
});
