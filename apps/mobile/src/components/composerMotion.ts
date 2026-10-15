import { ReduceMotion } from "react-native-reanimated";

// Layout and corner changes share one spring; keyboard motion stays native.
export const COMPOSER_SPRING = {
  damping: 26,
  stiffness: 260,
  mass: 0.8,
  reduceMotion: ReduceMotion.System,
};
