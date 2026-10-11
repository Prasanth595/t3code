import type { HomeListFilterMenuProject } from "./home-list-filter-menu";

/** Android draws `representative` itself; see the `.ios.ts` sibling. */
export function useProjectFilterMenuIcons<T extends HomeListFilterMenuProject>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return projects;
}
