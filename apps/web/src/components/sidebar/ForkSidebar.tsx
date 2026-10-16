/**
 * Fork parts of the sidebar thread list header (`Sidebar.tsx`): the repository owner filter and
 * the thread group tabs. The sidebar imports this module once and keeps one line per hook.
 */
import type { ComponentProps } from "react";

import { SidebarGroupTabs } from "./SidebarGroupTabs";
import { SidebarOwnerFilterMenu, SidebarOwnerFilterNotice } from "./SidebarOwnerFilter";
import type { useSidebarOwnerFilter } from "./useSidebarOwnerFilter";

export { useSidebarGroups } from "./useSidebarGroups";
export { useSidebarOwnerFilter } from "./useSidebarOwnerFilter";

type OwnerFilterState = Pick<
  ReturnType<typeof useSidebarOwnerFilter>,
  | "repositoryOwnerFiltersEnabled"
  | "ownerOptions"
  | "savedOwnerFilter"
  | "ownerFilter"
  | "ownerHiddenProjectCount"
  | "ownerHiddenThreadsNeedingUser"
  | "setOwnerFilter"
>;

/** The owner menu in the header, while `repositoryOwnerFilters` is on. */
export function OwnerFilterMenu({ owner }: { readonly owner: OwnerFilterState }) {
  return owner.repositoryOwnerFiltersEnabled ? (
    <SidebarOwnerFilterMenu
      options={owner.ownerOptions}
      filter={owner.savedOwnerFilter}
      onChange={owner.setOwnerFilter}
    />
  ) : null;
}

/** Below the header: the owner filter notice and the group tabs. */
export function HeaderFilterRows({
  owner,
  ...tabs
}: { readonly owner: OwnerFilterState } & ComponentProps<typeof SidebarGroupTabs>) {
  return (
    <>
      {owner.ownerFilter !== null ? (
        <SidebarOwnerFilterNotice
          filter={owner.savedOwnerFilter}
          hiddenProjectCount={owner.ownerHiddenProjectCount}
          hiddenThreadsNeedingUser={owner.ownerHiddenThreadsNeedingUser}
          onChange={owner.setOwnerFilter}
        />
      ) : null}
      {tabs.groups.enabled ? <SidebarGroupTabs {...tabs} /> : null}
    </>
  );
}
