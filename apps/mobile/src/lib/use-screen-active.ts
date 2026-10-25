import { useIsFocused } from "@react-navigation/native";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

const subscribe = (changed: () => void) => {
  const subscription = AppState.addEventListener("change", changed);
  return () => subscription.remove();
};
const isActive = () => AppState.currentState === "active";

/** Navigation focus survives Home; Android window blur is not an app background event. */
export function useScreenActive(): boolean {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribe, isActive, isActive);
  return focused && active;
}
