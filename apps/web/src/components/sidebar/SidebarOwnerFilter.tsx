/**
 * Fork: the sidebar owner filter controls. The menu sits with the header icons. The notice shows
 * under the header while the filter is on, and clears it with one click.
 */
import { Building2Icon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { sidebarOwnerLabel, type SidebarOwner, type SidebarOwnerOption } from "./ownerFilter.logic";

function ownerListLabel(owners: readonly SidebarOwner[]): string {
  return owners.map(sidebarOwnerLabel).join(", ");
}

export function SidebarOwnerFilterMenu(props: {
  options: readonly SidebarOwnerOption[];
  selected: readonly SidebarOwner[];
  onChange: (owners: readonly SidebarOwner[]) => void;
}) {
  const { options, selected, onChange } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              selected.length > 0
                ? `Filter projects by owner: ${ownerListLabel(selected)}`
                : "Filter projects by owner"
            }
          />
        }
      >
        <Building2Icon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Repository owner</MenuGroupLabel>
          {options.map((option) => (
            <MenuCheckboxItem
              // Owners are never empty, so the empty key cannot collide.
              key={option.owner ?? ""}
              checked={selected.includes(option.owner)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, option.owner]
                    : selected.filter((owner) => owner !== option.owner),
                )
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
        {selected.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange([])}>Show all owners</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function SidebarOwnerFilterNotice(props: {
  selected: readonly SidebarOwner[];
  onClear: () => void;
}) {
  const label = `${props.selected.length === 1 ? "Owner" : "Owners"}: ${ownerListLabel(props.selected)}`;
  return (
    <div
      role="status"
      className="flex h-7 items-center gap-2 px-2 text-xs text-sidebar-muted-foreground"
    >
      <Building2Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Button
        type="button"
        size="icon-micro"
        variant="ghost-muted"
        className="shrink-0"
        aria-label="Clear owner filter"
        onClick={props.onClear}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
