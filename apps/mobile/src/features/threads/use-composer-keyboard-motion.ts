import { useEffect, useState } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

/** Read the keyboard's destination height before its transition completes. */
export function useComposerKeyboardMotion() {
  const [height, setHeight] = useState(() => KeyboardController.state().height);
  useEffect(() => {
    const subscriptions = [
      KeyboardEvents.addListener("keyboardWillShow", (event) => {
        setHeight(event.height);
      }),
      KeyboardEvents.addListener("keyboardWillHide", () => {
        setHeight(0);
      }),
      KeyboardEvents.addListener("keyboardDidShow", (event) => {
        setHeight(event.height);
      }),
      KeyboardEvents.addListener("keyboardDidHide", () => {
        setHeight(0);
      }),
    ];
    setHeight(KeyboardController.state().height);
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return { height };
}
