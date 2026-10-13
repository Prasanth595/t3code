/**
 * Fork: the Owner submenu of the pull request Filters menu, shown only while
 * `repositoryOwnerFilters` is on. It lives in its own file, so that the upstream menu file changes
 * little. If upstream T3 Code ships an owner or organization filter, drop this fork version and
 * use theirs.
 */
import { Building2Icon, EyeIcon, EyeOffIcon, LayersIcon } from "lucide-react";

import type { FilterOperator } from "../filters/FilterChip";
import {
  MenuCheckboxItem,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { MAX_PULL_REQUEST_LIST_OWNERS } from "./pullRequestListPreferences";
import { pullRequestProjectOwners } from "./pullRequestOwnerFilter.logic";

export interface PullRequestOwnerSubmenuProps {
  /** Lowercase owners, as `repositoryOwnerOf` gives them. Empty means every owner. */
  readonly selected: ReadonlyArray<string>;
  /** "is" shows only the selected owners, "is_not" hides them. */
  readonly operator: FilterOperator;
  /** The projects that feed the list. The menu offers the owners of those with threads. */
  readonly projects: Parameters<typeof pullRequestProjectOwners>[0];
  readonly onChange: (owners: ReadonlyArray<string>) => void;
  readonly onOperator: (operator: FilterOperator) => void;
}

function ownerFilterSummary(selected: ReadonlyArray<string>, operator: FilterOperator): string {
  const [first] = selected;
  if (first === undefined) return "All";
  if (operator === "is") return selected.length === 1 ? first : `${selected.length} selected`;
  return selected.length === 1 ? `Not ${first}` : `Hiding ${selected.length}`;
}

export function PullRequestOwnerSubmenu({
  selected,
  operator,
  projects,
  onChange,
  onOperator,
}: PullRequestOwnerSubmenuProps) {
  // Read here, not on the page: the submenu renders only while the Filters menu is open, so
  // thread updates do not re-render the whole page.
  const threads = useThreadShells();
  const options = useMemo(() => pullRequestProjectOwners(projects, threads), [projects, threads]);
  // A selected owner with no project here stays in the list, so that the reader can clear it.
  const visible = [...selected.filter((owner) => !options.includes(owner)), ...options];
  const full = selected.length >= MAX_PULL_REQUEST_LIST_OWNERS;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Building2Icon aria-hidden className="size-3.5" />
        <span className="flex-1">Owner</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {ownerFilterSummary(selected, operator)}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        {/* One operator for all owners: a pull request has one owner, so "only A" and "not B"
            are never needed together. */}
        <MenuRadioGroup
          value={operator}
          onValueChange={(next) => {
            if (next === "is" || next === "is_not") onOperator(next);
          }}
        >
          <MenuRadioItem value="is">
            <span className="flex min-w-0 items-center gap-2">
              <EyeIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Show only selected</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="is_not">
            <span className="flex min-w-0 items-center gap-2">
              <EyeOffIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Hide selected</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem disabled={selected.length === 0} onClick={() => onChange([])}>
          <LayersIcon aria-hidden className="size-3.5" />
          All owners
        </MenuItem>
        <MenuSeparator />
        {visible.length === 0 ? (
          <MenuItem disabled>No owners in this view</MenuItem>
        ) : (
          visible.map((owner) => {
            const checked = selected.includes(owner);
            return (
              <MenuCheckboxItem
                key={owner}
                checked={checked}
                disabled={!checked && full}
                onCheckedChange={(next) =>
                  onChange(next ? [...selected, owner] : selected.filter((name) => name !== owner))
                }
              >
                <span className="block min-w-0 truncate">{owner}</span>
              </MenuCheckboxItem>
            );
          })
        )}
      </MenuSubPopup>
    </MenuSub>
  );
}
