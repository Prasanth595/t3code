/**
 * Fork: the sidebar owner filter controls. The menu sits with the header icons. The chip shows
 * under the header while the filter is on, so a hidden owner stays in view. If upstream T3 Code
 * ships an owner or organization filter for the sidebar, drop this fork version and use theirs.
 */
import type { SidebarOwnerFilter } from "@t3tools/contracts";
import { Building2Icon } from "lucide-react";

import { FilterChip, flipFilterOperator, type FilterOperator } from "../filters/FilterChip";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { sidebarOwnerLabel, type SidebarOwner, type SidebarOwnerOption } from "./ownerFilter.logic";

function ownerListLabel(owners: readonly SidebarOwner[]): string {
  return owners.map(sidebarOwnerLabel).join(", ");
}

const OPERATOR_OPTIONS = [
  { operator: "is", label: "Show only" },
  { operator: "is_not", label: "Hide" },
] as const satisfies ReadonlyArray<{ operator: FilterOperator; label: string }>;

export function SidebarOwnerFilterMenu(props: {
  options: readonly SidebarOwnerOption[];
  filter: SidebarOwnerFilter;
  onChange: (filter: SidebarOwnerFilter) => void;
}) {
  const { options, filter, onChange } = props;
  const { operator, owners } = filter;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              owners.length > 0
                ? `Filter projects by owner: ${operator === "is" ? "showing only" : "hiding"} ${ownerListLabel(owners)}`
                : "Filter projects by owner"
            }
          />
        }
      >
        <Building2Icon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={operator}
          onValueChange={(next) => {
            if (next === "is" || next === "is_not") onChange({ operator: next, owners });
          }}
        >
          {OPERATOR_OPTIONS.map((option) => (
            <MenuRadioItem key={option.operator} value={option.operator}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Repository owner</MenuGroupLabel>
          {options.map((option) => (
            <MenuCheckboxItem
              // Owners are never empty, so the empty key cannot collide.
              key={option.owner ?? ""}
              checked={owners.includes(option.owner)}
              onCheckedChange={(checked) =>
                onChange({
                  operator,
                  owners: checked
                    ? [...owners, option.owner]
                    : owners.filter((owner) => owner !== option.owner),
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{sidebarOwnerLabel(option.owner)}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {option.projectCount}
                </span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        {owners.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange({ operator, owners: [] })}>Show all owners</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function SidebarOwnerFilterNotice(props: {
  filter: SidebarOwnerFilter;
  /** The number of project groups that the filter hides. */
  hiddenProjectCount: number;
  onChange: (filter: SidebarOwnerFilter) => void;
}) {
  const { filter, hiddenProjectCount, onChange } = props;
  return (
    <div role="status" className="flex h-7 min-w-0 items-center px-2">
      <FilterChip
        field="Owner"
        operator={filter.operator}
        value={ownerListLabel(filter.owners)}
        detail={`${hiddenProjectCount} ${hiddenProjectCount === 1 ? "project" : "projects"} hidden`}
        onFlip={() => onChange({ ...filter, operator: flipFilterOperator(filter.operator) })}
        onRemove={() => onChange({ ...filter, owners: [] })}
      />
    </div>
  );
}
