import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";

export function scopeProjectSettingsGroup(
  group: SidebarProjectSnapshot,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  const representative =
    members.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? members[0]!;
  return { ...group, ...representative, memberProjects: members };
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}
