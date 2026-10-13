import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { Project } from "../../types";
import type { FilterOperator } from "../filters/FilterChip";
import {
  buildSidebarOwnerOptions,
  filterSidebarProjectGroupsByOwner,
  filterSidebarThreadsByOwner,
  resolveSidebarOwnerFilter,
  sidebarProjectGroupMemberKeys,
} from "./ownerFilter.logic";

const mac = EnvironmentId.make("environment-mac");
const vps = EnvironmentId.make("environment-vps");

function identity(canonicalKey: string, originKey?: string): RepositoryIdentity {
  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
    ...(originKey === undefined ? {} : { origin: { canonicalKey: originKey } }),
  };
}

function project(
  environmentId: EnvironmentId,
  id: string,
  repositoryIdentity: RepositoryIdentity | null,
): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    scripts: [],
  };
}

// One work repository checked out on two machines, a personal repository, a fork of an
// upstream repository, and a folder without a remote.
const groups = buildSidebarProjectSnapshots({
  projects: [
    project(mac, "work-mac", identity("github.com/qlik-trial/app")),
    project(vps, "work-vps", identity("github.com/qlik-trial/app")),
    project(mac, "dotfiles", identity("github.com/yarden-zamir/dotfiles")),
    project(
      mac,
      "t3code",
      identity("github.com/pingdotgg/t3code", "github.com/yarden-zamir/t3code"),
    ),
    project(mac, "notes", null),
  ],
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: mac,
  resolveEnvironmentLabel: () => null,
});

function visibleProjectKeys(operator: FilterOperator, owners: ReadonlyArray<string | null>) {
  const filter = resolveSidebarOwnerFilter({ enabled: true, filter: { operator, owners } });
  return filter === null
    ? null
    : sidebarProjectGroupMemberKeys(filterSidebarProjectGroupsByOwner(groups, filter));
}

describe("resolveSidebarOwnerFilter", () => {
  it("filters only while the setting is on and owners are selected", () => {
    expect(
      resolveSidebarOwnerFilter({
        enabled: false,
        filter: { operator: "is", owners: ["qlik-trial"] },
      }),
    ).toBeNull();
    expect(
      resolveSidebarOwnerFilter({ enabled: true, filter: { operator: "is_not", owners: [] } }),
    ).toBeNull();
    expect(
      resolveSidebarOwnerFilter({
        enabled: true,
        filter: { operator: "is_not", owners: ["qlik-trial", null] },
      }),
    ).toEqual({ operator: "is_not", owners: new Set(["qlik-trial", null]) });
  });
});

describe("buildSidebarOwnerOptions", () => {
  it("counts projects per owner, a fork under its own owner, and projects without an owner last", () => {
    expect(buildSidebarOwnerOptions(groups, [])).toEqual([
      { owner: "qlik-trial", projectCount: 1 },
      { owner: "yarden-zamir", projectCount: 2 },
      { owner: null, projectCount: 1 },
    ]);
  });

  it("keeps a selected owner that no project has, so the user can clear it", () => {
    expect(buildSidebarOwnerOptions(groups, ["gone-org"])).toContainEqual({
      owner: "gone-org",
      projectCount: 0,
    });
  });
});

describe("owner filter project keys", () => {
  it("shows every machine's checkout of a selected owner's repository", () => {
    expect(visibleProjectKeys("is", ["qlik-trial"])).toEqual(
      new Set([`${mac}:work-mac`, `${vps}:work-vps`]),
    );
  });

  it("selects projects without an owner through null", () => {
    expect(visibleProjectKeys("is", [null])).toEqual(new Set([`${mac}:notes`]));
  });

  it("hides every machine's checkout of a hidden owner's repository", () => {
    expect(visibleProjectKeys("is_not", ["qlik-trial"])).toEqual(
      new Set([`${mac}:dotfiles`, `${mac}:t3code`, `${mac}:notes`]),
    );
  });

  it("hides projects without an owner through null", () => {
    expect(visibleProjectKeys("is_not", [null])).toEqual(
      new Set([`${mac}:work-mac`, `${vps}:work-vps`, `${mac}:dotfiles`, `${mac}:t3code`]),
    );
  });

  it("returns no keys when nothing is selected", () => {
    expect(visibleProjectKeys("is", [])).toBeNull();
    expect(visibleProjectKeys("is_not", [])).toBeNull();
  });
});

describe("filterSidebarThreadsByOwner", () => {
  const runtime = {
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const thread = (id: string, projectId: string, overrides: ThreadFixtureOverrides = {}) =>
    makeThreadFixture({
      id: ThreadId.make(id),
      environmentId: mac,
      projectId: ProjectId.make(projectId),
      ...overrides,
    });

  const threads = [
    thread("work", "work-mac"),
    thread("idle-personal", "dotfiles"),
    thread("running-personal", "dotfiles", {
      runtime: { ...runtime, status: "running" },
    }),
    thread("approval-personal", "dotfiles", { hasPendingApprovals: true }),
    thread("question-personal", "dotfiles", { hasPendingUserInput: true }),
  ];

  it("hides threads of hidden projects but keeps the ones that run or wait for the user", () => {
    expect(
      filterSidebarThreadsByOwner(threads, visibleProjectKeys("is", ["qlik-trial"])).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["work", "running-personal", "approval-personal", "question-personal"]);
  });

  it("keeps the same threads when the filter hides the other owners instead", () => {
    expect(
      filterSidebarThreadsByOwner(
        threads,
        visibleProjectKeys("is_not", ["yarden-zamir", null]),
      ).map((candidate) => candidate.id),
    ).toEqual(["work", "running-personal", "approval-personal", "question-personal"]);
  });

  it("returns the same array without a filter", () => {
    expect(filterSidebarThreadsByOwner(threads, null)).toBe(threads);
  });
});
