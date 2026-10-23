// Factory and its run pages replace the sidebar utility row with a Back
// button, like Settings. `isSidebarUtilityPage` calls this first.
export function isFactoryPage(pathname: string): boolean {
  return pathname === "/factory" || pathname.startsWith("/factory/");
}
