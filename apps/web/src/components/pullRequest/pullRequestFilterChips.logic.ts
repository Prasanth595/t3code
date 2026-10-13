/**
 * Fork: the chips of the `pullRequestFilterChips` setting. Each active menu filter becomes one
 * chip with the list scope change that removes it and, where the filter has a negative form, the
 * change that flips it. Typed qualifiers stay in the search box, where the reader already sees
 * them, so they get no chip. A menu filter that a typed qualifier replaces gets no chip either,
 * because it does not apply. If upstream T3 Code ships its own active-filter chips, drop this
 * fork version and use theirs.
 */
import type { PullRequestListFilters } from "@t3tools/contracts";

import type { FilterOperator } from "../filters/FilterChip";
import type {
  PullRequestListPreferencePatch,
  PullRequestListPreferences,
} from "./pullRequestListPreferences";
import type { PullRequestOwnerFilter } from "./pullRequestOwnerFilter.logic";

export interface PullRequestFilterChip {
  readonly key: string;
  readonly field: string;
  readonly operator: FilterOperator | null;
  readonly value: string;
  /** The list scope change that removes this filter. */
  readonly remove: PullRequestListPreferencePatch;
  /** The change that flips the filter between is and is not. Absent without a negative form. */
  readonly flip?: PullRequestListPreferencePatch;
}

/** The names that the page reads from its menus. Null when that filter is not set. */
export interface PullRequestFilterChipNames {
  readonly state: string;
  readonly involvement: string;
  readonly project: string | null;
  readonly server: string | null;
  readonly host: string | null;
  readonly review: string | null;
  readonly checks: string | null;
}

/** The longest search that the URL keeps. */
const MAX_QUERY_LENGTH = 200;

/**
 * A typed exclusion of one label. The menu keeps no excluded labels, so a menu label flips into
 * the search box. Null for a name with a quote, which the search box cannot hold.
 */
function excludedLabelQuery(query: string | undefined, label: string): string | null {
  if (label.includes('"')) return null;
  const token =
    label.includes(" ") || label.includes(",") ? `-label:"${label}"` : `-label:${label}`;
  const next = [query?.trim() ?? "", token].filter((part) => part.length > 0).join(" ");
  return next.length > MAX_QUERY_LENGTH ? null : next;
}

export function pullRequestFilterChips(input: {
  readonly search: PullRequestListPreferences;
  /** The qualifiers in the search box now. */
  readonly typed: {
    readonly filters: PullRequestListFilters;
    readonly owners?: PullRequestOwnerFilter | undefined;
  };
  /** The `repositoryOwnerFilters` setting. */
  readonly ownerFilters: boolean;
  readonly names: PullRequestFilterChipNames;
}): ReadonlyArray<PullRequestFilterChip> {
  const { search, typed, names } = input;
  const chips: PullRequestFilterChip[] = [];
  const plain = (key: string, field: string, value: string, remove: PullRequestFilterChip["remove"]) =>
    chips.push({ key, field, operator: null, value, remove });

  if (search.state !== "open") plain("state", "State", names.state, { state: "open" });
  if (search.involvement !== "all") {
    plain("involvement", "Involvement", names.involvement, { involvement: "all" });
  }
  // A project scope names its server too, so the server gets a chip only without one.
  if (names.project !== null) plain("project", "Project", names.project, { projectId: undefined });
  else if (names.server !== null) {
    plain("server", "Server", names.server, { environmentId: undefined });
  }
  if (names.host !== null) plain("host", "Provider", names.host, { host: undefined });
  if (search.draft !== undefined && typed.filters.draft === undefined) {
    chips.push({
      key: "draft",
      field: "Pull request",
      operator: search.draft === "only" ? "is" : "is_not",
      value: "draft",
      remove: { draft: undefined },
      flip: { draft: search.draft === "only" ? "hide" : "only" },
    });
  }
  if (names.review !== null && typed.filters.review === undefined) {
    plain("review", "Review", names.review, { review: undefined });
  }
  if (names.checks !== null && typed.filters.checks === undefined) {
    plain("checks", "Checks", names.checks, { checks: undefined });
  }
  if (search.author !== undefined && typed.filters.author === undefined) {
    plain("author", "Author", search.author, { author: undefined });
  }
  if (search.labels !== undefined && typed.filters.labels === undefined) {
    for (const label of search.labels) {
      const rest = search.labels.filter((name) => name !== label);
      const labels = rest.length === 0 ? undefined : rest;
      const q = excludedLabelQuery(search.q, label);
      chips.push({
        key: `label:${label}`,
        field: "Label",
        operator: "is",
        value: label,
        remove: { labels },
        ...(q === null ? {} : { flip: { labels, q } }),
      });
    }
  }
  const owners = search.owners ?? [];
  if (input.ownerFilters && owners.length > 0 && typed.owners === undefined) {
    const operator = search.ownerOperator ?? "is";
    chips.push({
      key: "owner",
      field: "Owner",
      operator,
      value: owners.join(", "),
      remove: { owners: undefined },
      flip: { ownerOperator: operator === "is" ? "is_not" : undefined },
    });
  }
  return chips;
}

/** The change that removes every chip at once, the server scope included. */
export function clearPullRequestFilterChips(
  chips: ReadonlyArray<PullRequestFilterChip>,
): PullRequestListPreferencePatch {
  return chips.reduce<PullRequestListPreferencePatch>(
    (patch, chip) => ({ ...patch, ...chip.remove }),
    { environmentId: undefined },
  );
}
