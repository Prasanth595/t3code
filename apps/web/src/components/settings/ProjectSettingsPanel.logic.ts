export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
  currentGroupTitle?: string,
): boolean {
  return (
    wasEdited &&
    ((currentGroupTitle !== undefined && currentGroupTitle !== nextTitle) ||
      memberTitles.some((title) => title !== nextTitle))
  );
}
