import type { NavigationState, PartialState } from "@react-navigation/native";

import { resetRootStack, type RootStackNavigation } from "../../lib/root-stack-reset";

type RootParams = ReactNavigation.RootParamList;

/** Root routes that make up the Settings tab. The legal documents open as a modal instead. */
export type SettingsRouteName = Exclude<
  Extract<keyof RootParams, `Settings${string}`>,
  "SettingsLegal"
>;

export function isSettingsRoute(name: string): boolean {
  return name.startsWith("Settings") && name !== "SettingsLegal";
}

/**
 * Settings is open while its `Settings` route is under the topmost workspace page and that
 * page is a Settings page. A Settings page pushed without it, such as a usage account opened
 * from the Usage tab, stays a detail of the current tab.
 */
export function settingsOpenIn(workspaceRoutes: readonly { readonly name: string }[]): boolean {
  return (
    workspaceRoutes.some((route) => route.name === "Settings") &&
    isSettingsRoute(workspaceRoutes.at(-1)?.name ?? "")
  );
}

/** A `settings/...` link names only its page, so put the Settings tab's route under it. */
export function restoreSettingsLinkState(state: PartialState<NavigationState> | undefined) {
  if (!state) return state;
  const first = state.routes.findIndex((route) => isSettingsRoute(route.name));
  if (first < 0 || state.routes.some((route) => route.name === "Settings")) return state;
  const routes = [...state.routes];
  routes.splice(first, 0, { name: "Settings" });
  return { ...state, index: routes.length - 1, routes };
}

type SettingsPageArgs<Name extends SettingsRouteName> = undefined extends RootParams[Name]
  ? [params?: RootParams[Name]]
  : [params: RootParams[Name]];

/**
 * Settings pages sit on the root stack above Home, under a `Settings` route that keeps the
 * Settings list as the workspace's primary content. Opening a page replaces whatever was
 * above Home, so the tab always starts from its list and Back returns there.
 */
export function settingsNavigationState<
  State extends { readonly routes: readonly { readonly name: string }[] },
>(state: State, page: SettingsRouteName = "Settings", params?: object) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  const list = state.routes.find((route) => route.name === "Settings") ?? { name: "Settings" };
  const routes = [home, list, ...(page === "Settings" ? [] : [{ name: page, params }])];
  return { ...state, index: routes.length - 1, routes };
}

/** Opens the Settings tab, optionally at one of its pages. */
export function openSettings<Name extends SettingsRouteName = "Settings">(
  navigation: RootStackNavigation,
  page?: Name,
  ...[params]: SettingsPageArgs<Name>
) {
  resetRootStack(navigation, (state) => settingsNavigationState(state, page, params));
}
