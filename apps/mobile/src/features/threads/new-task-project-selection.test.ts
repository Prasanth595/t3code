import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  newTaskDestination,
  orderSuggestedProjectFirst,
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
  // The draft screen opens the picker for a draft without a project when more than one is selectable.
  const projects = [makeProject("first"), makeProject("current", "other-environment")];
  const scopes = projects.map((project) => makeScope([project], project.id));
  const openFromNewThread = (current: EnvironmentProject | undefined) => {
    const { draft } = newTaskDestination(current, "request");
    return {
      draft,
      selection: resolveDraftProjectSelection(null, projects, scopes),
      pickerScopes: orderSuggestedProjectFirst(scopes, draft.suggestedProjectKey),
    };
  };

  it("asks for a project with a thread open, listing its project first", () => {
    const opened = openFromNewThread(projects[1]);
    expect(opened.draft).toEqual({
      requestId: "request",
      suggestedProjectKey: "other-environment:current",
    });
    expect(opened.selection).toEqual({ kind: "pick" });
    expect(opened.pickerScopes.map((scope) => scope.key)).toEqual(["current", "first"]);
  });

  it("asks for a project in the existing order with no thread open", () => {
    const opened = openFromNewThread(undefined);
    expect(opened.draft).toEqual({ requestId: "request" });
    expect(opened.selection).toEqual({ kind: "pick" });
    expect(opened.pickerScopes).toBe(scopes);
  });

  it("opens the draft directly in the only selectable project", () => {
    const only = makeProject("only");
    expect(newTaskDestination(only, "request").draft).toEqual({
      requestId: "request",
      suggestedProjectKey: "environment:only",
    });
    expect(resolveDraftProjectSelection(null, [only], [makeScope([only])])).toEqual({
      kind: "select",
      project: only,
    });
  });

  it("keeps the current project's workspace when its scope is picked", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const scope = makeScope([mac, server]);
    const { draft } = newTaskDestination(server, "request");
    expect(
      orderSuggestedProjectFirst(
        [makeScope([projects[0]!], "first"), scope],
        draft.suggestedProjectKey,
      )[0],
    ).toBe(scope);
    expect(
      getProjectScopeSelectionTarget(scope, EnvironmentId.make("mac"), draft.suggestedProjectKey),
    ).toBe(server);
  });
});

describe("project-scoped new threads", () => {
  it("do not ask again once the route's project is applied", () => {
    const projects = [makeProject("first"), makeProject("chosen")];
    const scopes = projects.map((project) => makeScope([project], project.id));
    expect(resolveDraftProjectSelection("environment:chosen", projects, scopes)).toEqual({
      kind: "preserve",
    });
  });
});
