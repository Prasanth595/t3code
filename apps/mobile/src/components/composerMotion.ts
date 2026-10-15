import { LinearTransition, ReduceMotion } from "react-native-reanimated";

// Layout and corner changes share one spring; keyboard motion stays native.
export const COMPOSER_SPRING = {
  damping: 26,
  stiffness: 260,
  mass: 0.8,
  reduceMotion: ReduceMotion.System,
};
export const COMPOSER_LAYOUT_TRANSITION = LinearTransition.springify()
  .damping(COMPOSER_SPRING.damping)
  .stiffness(COMPOSER_SPRING.stiffness)
  .mass(COMPOSER_SPRING.mass)
  .reduceMotion(ReduceMotion.System);
