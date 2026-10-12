import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  narrowedEnvironmentId,
  type ResolvedEnvironmentSelection,
} from "@t3tools/client-runtime/state/environment-selection";
import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  type EnvironmentId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import { resolveHomeEnvironmentSelection } from "./home-environment-selection";
import type { HomeProjectSortOrder } from "./homeThreadList";

export interface HomeListOptions {
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  /**
   * The environment the list is narrowed to, or null for all. A missing
   * environment stays narrowed (to nothing) rather than widening to all.
   */
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly environmentSelection: ResolvedEnvironmentSelection;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedProjectKey: null,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}>) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(
    () => ({ options, setOptions, projectGroupingMode }),
    [options, projectGroupingMode],
  );
  return createElement(HomeListOptionsContext, { value }, children);
}

export function useHomeListOptions() {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  // The environment filter is a device preference, so it survives restarts.
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesLoaded = AsyncResult.isSuccess(preferencesResult);
  const storedEnvironmentId = preferencesLoaded ? preferencesResult.value.homeEnvironmentId : null;
  const environments = useWorkspaceEnvironments();
  const connectionsReady = useConnectionsReady();
  const environmentSelection = useMemo(
    () =>
      resolveHomeEnvironmentSelection(
        storedEnvironmentId,
        environments,
        connectionsReady && preferencesLoaded,
      ),
    [connectionsReady, environments, preferencesLoaded, storedEnvironmentId],
  );
  const resolvedOptions: ResolvedHomeListOptions = {
    ...options,
    selectedEnvironmentId: narrowedEnvironmentId(environmentSelection),
    environmentSelection,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedEnvironmentId = useCallback(
    (value: EnvironmentId | null) => {
      savePreferences({ homeEnvironmentId: value });
    },
    [savePreferences],
  );
  const setSelectedProjectKey = useCallback(
    (value: string | null) => {
      setOptions((current) => ({ ...current, selectedProjectKey: value }));
    },
    [setOptions],
  );
  const setProjectSortOrder = useCallback((value: HomeProjectSortOrder) => {
    setOptions((current) => ({ ...current, projectSortOrder: value }));
  }, []);
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
    setProjectSortOrder,
  } as const;
}
