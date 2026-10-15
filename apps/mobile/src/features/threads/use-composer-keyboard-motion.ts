import { useEffect, useState } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

/** Keep composer springs separate from the keyboard's native transition. */
export function useComposerKeyboardMotion() {
  const [height, setHeight] = useState(() => KeyboardController.state().height);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const subscriptions = [
      KeyboardEvents.addListener("keyboardWillShow", (event) => {
        setMoving(true);
        setHeight(event.height);
      }),
      KeyboardEvents.addListener("keyboardWillHide", () => {
        setMoving(true);
        setHeight(0);
      }),
      KeyboardEvents.addListener("keyboardDidShow", (event) => {
        setHeight(event.height);
        setMoving(false);
      }),
      KeyboardEvents.addListener("keyboardDidHide", () => {
        setHeight(0);
        setMoving(false);
      }),
    ];
    setHeight(KeyboardController.state().height);
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return { height, moving };
}
