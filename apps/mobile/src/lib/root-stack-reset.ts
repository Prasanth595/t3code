import type { CommonActions, NavigationState } from "@react-navigation/native";

export type RootStackResetAction = ReturnType<typeof CommonActions.reset> & {
  readonly target: string;
};

export interface RootStackNavigation {
  readonly dispatch: (action: RootStackResetAction) => void;
  readonly getParent: () => RootStackNavigation | undefined;
  readonly getState: () => NavigationState | undefined;
  /** Only on the navigation container, whose `getState` stays empty until the first action. */
  readonly getRootState?: () => NavigationState | undefined;
}

/**
 * Resets the root stack from anywhere. Always reads and targets the root navigator: the
 * sidebar and rail render in the root layout, where `useNavigation()` is the container, and a
 * container dispatch runs on the deepest focused navigator, which can be a nested stack that
 * rejects the reset.
 */
export function resetRootStack(
  navigation: RootStackNavigation,
  nextState: (state: NavigationState) => RootStackResetAction["payload"],
) {
  let root = navigation;
  for (let parent = root.getParent(); parent; parent = root.getParent()) root = parent;
  const state = root.getRootState?.() ?? root.getState();
  if (!state) return;
  // Same shape as `CommonActions.reset`, which would pull React Native into node tests.
  navigation.dispatch({ type: "RESET", payload: nextState(state), target: state.key });
}
