import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

/**
 * The v5 header adapter turns this intent into UISearchController and native toolbar items.
 * Earlier iOS versions use separate search and toolbar options.
 */
export const NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED = NATIVE_LIQUID_GLASS_SUPPORTED;

export const NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET = 56;

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  "type" | "useFallbackSearchField"
>;

export function createNativeMailSearchToolbarItem(
  input: NativeMailSearchToolbarInput,
): HeaderBarButtonMailSearchToolbarItem {
  return {
    placeholder: "Search",
    ...input,
    type: "mailSearchToolbar",
    useFallbackSearchField: true,
  };
}
