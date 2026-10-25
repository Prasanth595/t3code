import { useIsFocused } from "@react-navigation/native";
import { useEffect, useEffectEvent } from "react";
import { BackHandler } from "react-native";

/**
 * Handles the Android hardware back button while `active` and the owning screen
 * is focused. `onBack` returns false to let the press fall through.
 *
 * Registration depends only on `active` and focus, never on `onBack`'s identity:
 * BackHandler calls the newest listener first, so re-registering on every render
 * would move a covered screen's handler above the screen on top of it.
 */
export function useHardwareBack(active: boolean, onBack: () => boolean) {
  const focused = useIsFocused();
  const handleBack = useEffectEvent(onBack);
  useEffect(() => {
    if (!active || !focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => handleBack());
    return () => subscription.remove();
  }, [active, focused]);
}
