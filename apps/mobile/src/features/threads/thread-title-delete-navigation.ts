import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

interface ThreadRouteNavigation {
  readonly isFocused: () => boolean;
  readonly getState: () =>
    | {
        readonly index: number;
        readonly routes: ReadonlyArray<{ readonly params?: object }>;
      }
    | undefined;
}

function firstParam(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A delete lands after its confirmation and server round trip, so the thread route
 * only leaves for the list if it is still focused on the deleted thread. A newer
 * selection, a covering screen, or a removed route keeps the user where they are.
 */
export function threadRouteStillShows(
  navigation: ThreadRouteNavigation,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): boolean {
  if (!navigation.isFocused()) return false;
  const state = navigation.getState();
  const params = state?.routes[state.index]?.params as
    | { readonly environmentId?: unknown; readonly threadId?: unknown }
    | undefined;
  return (
    firstParam(params?.environmentId) === thread.environmentId &&
    firstParam(params?.threadId) === thread.id
  );
}
