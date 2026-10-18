/**
 * Fork: "Move to group" in the long-press menu of a thread row, the touch way to what a drag onto
 * a tab does on web. It shows while a connected server has `mobileSidebarGroups` on.
 */
import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildSidebarGroupProjectFacts,
  compileSidebarGroups,
  DEFAULT_SIDEBAR_GROUP_ID,
  moveSidebarThreads,
  sidebarDefaultTabName,
} from "@t3tools/client-runtime/state/sidebarGroups";
import type { SidebarGroups } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  createMobileSidebarGroup,
  editSidebarGroups,
  sidebarGroupsAtom,
} from "../../state/forkSidebarGroups";
import { environmentProjects } from "../../state/projects";
import { openSidebarGroupEditor } from "../settings/forkSidebarGroupEditor";

const MOVE_PREFIX = "fork-group:";
const NEW_GROUP_EVENT = `${MOVE_PREFIX}new`;
const NO_ITEMS: MenuAction[] = [];

/** The groups that can hold threads: the first tab and every group that is not a view. */
function moveMenuItems(settings: SidebarGroups): MenuAction[] {
  const compiled = compileSidebarGroups(settings);
  return [
    {
      id: "fork-group",
      title: "Move to group",
      image: "folder",
      subactions: [
        { id: `${MOVE_PREFIX}${DEFAULT_SIDEBAR_GROUP_ID}`, title: sidebarDefaultTabName(settings) },
        ...settings.groups
          .filter((group) => compiled.byId.get(group.id)?.isView !== true)
          .map((group) => ({ id: `${MOVE_PREFIX}${group.id}`, title: group.name })),
        { id: NEW_GROUP_EVENT, title: "New group…", image: "plus" },
      ],
    },
  ];
}

/**
 * The menu items, and the handler that returns true for an event it took. The items depend on
 * the groups alone, so every row shares the same work per change of the groups.
 */
export function useThreadGroupMenu(thread: EnvironmentThreadShell): {
  readonly items: MenuAction[];
  readonly handle: (event: string) => boolean;
} {
  const settings = useAtomValue(sidebarGroupsAtom);
  const navigation = useNavigation();
  const items = useMemo(() => (settings === null ? NO_ITEMS : moveMenuItems(settings)), [settings]);
  const handle = useCallback(
    (event: string) => {
      if (!event.startsWith(MOVE_PREFIX)) return false;
      // Read once at the tap, so the rows do not subscribe to the projects.
      const facts = buildSidebarGroupProjectFacts(
        appAtomRegistry.get(environmentProjects.projectsAtom),
      );
      if (event === NEW_GROUP_EVENT) {
        const id = createMobileSidebarGroup((current, groupId) =>
          moveSidebarThreads(current, [thread], groupId, facts),
        );
        openSidebarGroupEditor(navigation, id);
        return true;
      }
      const groupId = event.slice(MOVE_PREFIX.length);
      editSidebarGroups((current) => moveSidebarThreads(current, [thread], groupId, facts));
      return true;
    },
    [navigation, thread],
  );
  return { items, handle };
}
