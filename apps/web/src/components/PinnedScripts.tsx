import { useAtomValue } from "@effect/atom-react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  movePinnedScriptId,
  resolvePinnedScripts,
  togglePinnedScriptId,
} from "@t3tools/shared/projectScripts";
import {
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { create } from "zustand";

import { showContextMenuFallback } from "~/contextMenuFallback";
import { observeResize } from "~/lib/observeResize";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useStableCallback } from "../hooks/useStableCallback";
import { ScriptIcon } from "./projectScriptEditor";
import { Button } from "./ui/button";

const NO_PINS: readonly string[] = [];
const PIN_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToParentElement];

/** The thread view that can run scripts now. The title bar pins use it. */
export interface PinnedScriptsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectScripts: readonly ProjectScript[];
  /** Undefined when this client cannot run terminal commands. */
  readonly runScript: ((script: ProjectScript) => void) | undefined;
}

/**
 * The open thread view registers itself here, because the title bar sits
 * outside the thread view but its pins run in that thread's terminal.
 */
export const usePinnedScriptsTargetStore = create<{
  target: PinnedScriptsTarget | null;
}>(() => ({ target: null }));

/**
 * The pin and global script runners of the open thread view. Pins run like a pick from the
 * scripts menu. The view registers `runGlobalScript` as the title bar's target.
 */
export function useThreadPinnedScripts(input: {
  readonly environmentId: EnvironmentId;
  readonly activeProject: { readonly id: ProjectId } | null | undefined;
  readonly activeProjectScripts: readonly ProjectScript[];
  readonly canOperateTerminal: boolean;
  readonly runProjectScriptRef: {
    readonly current: (
      script: ProjectScript,
      options?: {
        readonly rememberAsLastInvoked?: boolean;
        readonly previewPresentation?: "panel" | "floating";
      },
    ) => Promise<void>;
  };
}) {
  const { environmentId, activeProject, activeProjectScripts, canOperateTerminal } = input;
  const { runProjectScriptRef } = input;
  // A global script does not become the project's preferred script, since it is not one of them.
  const runPinnedProjectScript = (script: ProjectScript) => {
    void runProjectScriptRef.current(script);
  };
  const runPinnedProjectScriptStable = useStableCallback(runPinnedProjectScript);
  // A global script belongs to no project, so its preview floats over the thread as a popup
  // instead of taking the project's right panel.
  const runGlobalScript = (script: ProjectScript) => {
    void runProjectScriptRef.current(script, {
      rememberAsLastInvoked: false,
      previewPresentation: "floating",
    });
  };
  const runGlobalScriptStable = useStableCallback(runGlobalScript);
  // The title bar sits outside this view, so it reaches the runner through the store.
  useEffect(() => {
    if (!activeProject) return;
    const target: PinnedScriptsTarget = {
      environmentId,
      projectId: activeProject.id,
      projectScripts: activeProjectScripts,
      runScript: canOperateTerminal ? runGlobalScriptStable : undefined,
    };
    usePinnedScriptsTargetStore.setState({ target });
    return () => {
      if (usePinnedScriptsTargetStore.getState().target === target) {
        usePinnedScriptsTargetStore.setState({ target: null });
      }
    };
  }, [
    activeProject,
    activeProjectScripts,
    canOperateTerminal,
    environmentId,
    runGlobalScriptStable,
  ]);
  return {
    runPinnedProjectScript: canOperateTerminal ? runPinnedProjectScriptStable : undefined,
    runGlobalScript: runGlobalScriptStable,
  };
}

/** Pins, their scripts and the writes that change them, for one environment and project. */
export function usePinnedScripts(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectScripts: readonly ProjectScript[];
}) {
  const { environmentId, projectId, projectScripts } = input;
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "pinned scripts update");
  const globalScripts = settings.globalScripts;
  const globalPinIds = settings.pinnedGlobalScriptIds;
  const projectPinIds = (projectId && settings.pinnedProjectScriptIds[projectId]) || NO_PINS;

  const writeGlobalPins = useCallback(
    (ids: readonly string[]) =>
      void updateSettings({ environmentId, input: { patch: { pinnedGlobalScriptIds: ids } } }),
    [environmentId, updateSettings],
  );
  const writeProjectPins = useCallback(
    (ids: readonly string[]) => {
      if (!projectId) return;
      void updateSettings({
        environmentId,
        input: { patch: { pinnedProjectScriptIds: { [projectId]: ids.length > 0 ? ids : null } } },
      });
    },
    [environmentId, projectId, updateSettings],
  );

  const openPinMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const menuItems = (
        group: "global" | "project",
        scripts: readonly ProjectScript[],
        pinnedIds: readonly string[],
      ): ContextMenuItem[] =>
        scripts.map((script) => ({
          id: `${group}:${script.id}`,
          label: script.name,
          checked: pinnedIds.includes(script.id),
          disabled: !canWrite,
        }));
      const items: ContextMenuItem[] = [
        ...(globalScripts.length > 0
          ? [
              {
                id: "global",
                label: "Pin global scripts",
                children: menuItems("global", globalScripts, globalPinIds),
              },
            ]
          : []),
        ...(projectId && projectScripts.length > 0
          ? [
              {
                id: "project",
                label: "Pin project scripts",
                children: menuItems("project", projectScripts, projectPinIds),
              },
            ]
          : []),
      ];
      if (items.length === 0) return;
      // The in-app menu, not the native one: it matches the app theme on every platform.
      const clicked = await showContextMenuFallback(items, position);
      if (!clicked || !canWrite) return;
      const separator = clicked.indexOf(":");
      if (separator < 0) return;
      const group = clicked.slice(0, separator);
      const scriptId = clicked.slice(separator + 1);
      if (group === "global") {
        writeGlobalPins(togglePinnedScriptId(globalScripts, globalPinIds, scriptId));
      } else if (group === "project") {
        writeProjectPins(togglePinnedScriptId(projectScripts, projectPinIds, scriptId));
      }
    },
    [
      canWrite,
      globalPinIds,
      globalScripts,
      projectId,
      projectPinIds,
      projectScripts,
      writeGlobalPins,
      writeProjectPins,
    ],
  );

  const pinnedGlobalScripts = useMemo(
    () => resolvePinnedScripts(globalScripts, globalPinIds),
    [globalPinIds, globalScripts],
  );
  const pinnedProjectScripts = useMemo(
    () => resolvePinnedScripts(projectScripts, projectPinIds),
    [projectPinIds, projectScripts],
  );
  const moveGlobalPin = useCallback(
    (scriptId: string, toIndex: number) =>
      writeGlobalPins(movePinnedScriptId(globalScripts, globalPinIds, scriptId, toIndex)),
    [globalPinIds, globalScripts, writeGlobalPins],
  );
  const moveProjectPin = useCallback(
    (scriptId: string, toIndex: number) =>
      writeProjectPins(movePinnedScriptId(projectScripts, projectPinIds, scriptId, toIndex)),
    [projectPinIds, projectScripts, writeProjectPins],
  );

  return {
    globalScripts,
    pinnedGlobalScripts,
    pinnedProjectScripts,
    /** Whether this environment uses global scripts or pins, so blank header space may open the pin menu. */
    inUse:
      globalScripts.length > 0 ||
      globalPinIds.length > 0 ||
      Object.keys(settings.pinnedProjectScriptIds).length > 0,
    /** Whether the pin menu has anything to list. */
    hasPinnableScripts:
      globalScripts.length > 0 || (projectId !== null && projectScripts.length > 0),
    canWrite,
    openPinMenu,
    moveGlobalPin,
    moveProjectPin,
  };
}

/**
 * Pinned script buttons that reorder by drag. Renders nothing when no script
 * is pinned, so the header and title bar keep their usual look.
 */
export function PinnedScriptsArea({
  area,
  scripts,
  canReorder,
  onRun,
  onMove,
  onOpenMenu,
}: {
  area: "header" | "titlebar";
  scripts: readonly ProjectScript[];
  canReorder: boolean;
  onRun: ((script: ProjectScript) => void) | undefined;
  onMove: (scriptId: string, toIndex: number) => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  // A small distance keeps a plain click a click instead of a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const toIndex = scripts.findIndex((script) => script.id === over.id);
      if (toIndex >= 0) onMove(String(active.id), toIndex);
    },
    [onMove, scripts],
  );
  if (scripts.length === 0) return null;
  return (
    <div
      className="pointer-events-auto flex min-w-0 shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-pinned-scripts-area={area}
      onContextMenu={(event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={PIN_DRAG_MODIFIERS}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={scripts.map((script) => script.id)}
          strategy={horizontalListSortingStrategy}
        >
          {scripts.map((script) => (
            <PinnedScriptButton
              key={script.id}
              script={script}
              canReorder={canReorder}
              onRun={onRun}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function PinnedScriptButton({
  script,
  canReorder,
  onRun,
}: {
  script: ProjectScript;
  canReorder: boolean;
  onRun: ((script: ProjectScript) => void) | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: script.id,
    disabled: !canReorder,
  });
  return (
    <Button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      size="xs"
      variant="ghost"
      data-pinned-script={script.id}
      aria-label={`Run ${script.name}`}
      title={script.command}
      disabled={!onRun}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-10" : undefined}
      onClick={() => onRun?.(script)}
    >
      <ScriptIcon icon={script.icon} />
      <span className="max-w-32 truncate">{script.name}</span>
    </Button>
  );
}

/**
 * Title bar pins for global scripts, run in the open thread view. Right-click
 * on the sidebar toggle (passed as children) or on a pin opens the pin menu.
 * Reports the pins' width so title bar content can move aside.
 */
export function TitlebarPinnedScripts({
  target,
  onWidthChange,
  children,
}: {
  target: PinnedScriptsTarget;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}) {
  const pins = usePinnedScripts({
    environmentId: target.environmentId,
    projectId: target.projectId,
    projectScripts: target.projectScripts,
  });
  const measureRef = useCallback(
    (element: HTMLDivElement) => {
      const stop = observeResize(element, () => onWidthChange(element.offsetWidth));
      return () => {
        stop();
        onWidthChange(0);
      };
    },
    [onWidthChange],
  );
  return (
    <div
      className="contents"
      onContextMenu={(event) => {
        // With nothing to pin, right-click keeps its usual behaviour.
        if (!pins.hasPinnableScripts) return;
        event.preventDefault();
        void pins.openPinMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {pins.pinnedGlobalScripts.length > 0 ? (
        <div ref={measureRef} className="ml-1 flex">
          <PinnedScriptsArea
            area="titlebar"
            scripts={pins.pinnedGlobalScripts}
            canReorder={pins.canWrite}
            onRun={target.runScript}
            onMove={pins.moveGlobalPin}
            onOpenMenu={(position) => void pins.openPinMenu(position)}
          />
        </div>
      ) : null}
    </div>
  );
}
