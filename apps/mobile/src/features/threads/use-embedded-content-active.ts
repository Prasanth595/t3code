import { useContext } from "react";
import { Platform } from "react-native";
import { useScreenActive } from "../../lib/use-screen-active";
import { ThreadMediaVisibleContext } from "./thread-media-visibility";

export function useEmbeddedContentActive(inline: boolean): boolean {
  const screenActive = useScreenActive();
  const rowVisible = useContext(ThreadMediaVisibleContext);
  return Platform.OS !== "android" || (screenActive && (!inline || rowVisible));
}
