import { describe, expect, it } from "vite-plus/test";

import {
  clearPullRequestFilterChips,
  pullRequestFilterChips,
  type PullRequestFilterChipNames,
} from "./pullRequestFilterChips.logic";
import type { PullRequestListPreferences } from "./pullRequestListPreferences";

const names: PullRequestFilterChipNames = {
  state: "Open",
  involvement: "All",
  project: null,
  server: null,
  host: null,
  review: null,
  checks: null,
};

function chips(
  search: Partial<PullRequestListPreferences>,
  options: {
    typed?: Parameters<typeof pullRequestFilterChips>[0]["typed"];
    names?: Partial<PullRequestFilterChipNames>;
    ownerFilters?: boolean;
  } = {},
) {
  return pullRequestFilterChips({
    search: { involvement: "all", state: "open", ...search },
    typed: options.typed ?? { filters: {} },
    ownerFilters: options.ownerFilters ?? true,
    names: { ...names, ...options.names },
  });
}

describe("pullRequestFilterChips", () => {
  it("shows no chip for the default list", () => {
    expect(chips({})).toEqual([]);
  });

  it("flips the owner menu between show only and hide, and removes it", () => {
    const [owner] = chips({ owners: ["qlik-trial", "a"], ownerOperator: "is_not" });
    expect(owner).toMatchObject({ field: "Owner", operator: "is_not", value: "qlik-trial, a" });
    expect(owner?.flip).toEqual({ ownerOperator: undefined });
    expect(owner?.remove).toEqual({ owners: undefined });
    expect(chips({ owners: ["a"] })[0]?.flip).toEqual({ ownerOperator: "is_not" });
  });

  it("leaves out the owner menu while the owner setting is off or a typed owner replaces it", () => {
    expect(chips({ owners: ["a"] }, { ownerFilters: false })).toEqual([]);
    const typed = { filters: {}, owners: { include: [], exclude: ["b"] } };
    expect(chips({ owners: ["a"] }, { typed })).toEqual([]);
  });

  it("flips a menu label into a typed exclusion, quoted when it holds a space", () => {
    const [bug, design] = chips({ labels: ["bug", "needs design"], q: "fix" });
    expect(bug?.remove).toEqual({ labels: ["needs design"] });
    expect(bug?.flip).toEqual({ labels: ["needs design"], q: "fix -label:bug" });
    expect(design?.flip).toEqual({ labels: ["bug"], q: 'fix -label:"needs design"' });
  });

  it("offers no flip for a label that the search box cannot hold", () => {
    expect(chips({ labels: ['say "hi"'] })[0]?.flip).toBeUndefined();
  });

  it("leaves out menu labels that typed labels replace, but not for typed exclusions", () => {
    expect(chips({ labels: ["bug"] }, { typed: { filters: { labels: [["x"]] } } })).toEqual([]);
    expect(
      chips({ labels: ["bug"] }, { typed: { filters: { excludedLabels: ["x"] } } }),
    ).toHaveLength(1);
  });

  it("flips drafts between only and hidden", () => {
    const [draft] = chips({ draft: "hide" });
    expect(draft).toMatchObject({ operator: "is_not", value: "draft", flip: { draft: "only" } });
  });

  it("names the project scope instead of its server", () => {
    const scoped = chips({}, { names: { project: "t3code", server: "Mac" } });
    expect(scoped.map((chip) => chip.key)).toEqual(["project"]);
    expect(chips({}, { names: { server: "Mac" } })[0]?.remove).toEqual({
      environmentId: undefined,
    });
  });

  it("clears every chip and the server scope at once", () => {
    const all = chips(
      { state: "merged", owners: ["a"], draft: "only" },
      { names: { state: "Merged", project: "t3code" } },
    );
    expect(clearPullRequestFilterChips(all)).toEqual({
      environmentId: undefined,
      state: "open",
      projectId: undefined,
      draft: undefined,
      owners: undefined,
    });
  });
});
