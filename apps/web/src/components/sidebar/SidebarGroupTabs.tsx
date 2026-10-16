/**
 * Fork: the tab bar of sidebar thread groups, under the Search field. Each tab is a group: a view
 * with rules over the same threads. Drop a thread on a tab to move it there, or on the empty end
 * of the bar to make a new group.
 */
import {
  isKnownSidebarGroupRule,
  type SidebarGroup,
  type SidebarGroupRule,
  type SidebarGroupRuleField,
  type SidebarGroupStoredRule,
  type SidebarGroups,
} from "@t3tools/contracts";
import { BanIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";

import { AppIcon, GroupIcon, GROUP_ICON_IDS } from "../AppIcon";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarThreadSummary } from "../../types";
import { FilterChip, flipFilterOperator } from "../filters/FilterChip";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  DEFAULT_SIDEBAR_GROUP_ID,
  DEFAULT_SIDEBAR_GROUP_NAME,
  fitSidebarGroupTabs,
  isAnyGroupRule,
  SIDEBAR_GROUP_RULE_FIELDS,
  sidebarGroupRuleFieldLabel,
  toggleSidebarGroupRuleValue,
  type SidebarGroupRuleOption,
} from "./sidebarGroups.logic";
import { THREAD_CARD_TITLE_CLASS } from "./threadCardParts";
import {
  SIDEBAR_GROUP_DROP_ATTRIBUTE,
  SIDEBAR_GROUP_DROP_MORE,
  SIDEBAR_GROUP_DROP_NEW,
  type SidebarGroupsState,
  type SidebarGroupTab,
} from "./useSidebarGroups";

const attentionKeyframes: Keyframe[] = [
  { transform: "rotate(0deg)" },
  { transform: "rotate(-4deg)" },
  { transform: "rotate(4deg)" },
  { transform: "rotate(-2deg)" },
  { transform: "rotate(0deg)" },
];

/**
 * Plays a short wiggle when a tab starts to need the user. It runs a fixed number of times and
 * stops: a looping animation repaints on every frame (see AGENTS.md).
 */
function useAttentionWiggle(element: HTMLElement | null, attentionKey: string | null) {
  useEffect(() => {
    if (element === null || attentionKey === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.animate(attentionKeyframes, {
      duration: 450,
      iterations: 3,
      easing: "ease-in-out",
    });
    return () => animation.cancel();
  }, [attentionKey, element]);
}

/**
 * The status icon of the most urgent thread, else the group's own icon. A tab with neither an icon
 * nor a name shows the dot, so it never renders empty.
 */
function TabIcon(props: { tab: SidebarGroupTab }) {
  const { tab } = props;
  if (tab.status !== null) {
    return <AppIcon slot={tab.status.slot} className={cn("size-3.5", tab.status.className)} />;
  }
  const icon = tab.icon === "none" && !tab.showName ? undefined : tab.icon;
  return <GroupIcon icon={icon} className="size-3.5 text-muted-foreground" />;
}

/** What a tab shows: the favicon of a single thread, the status or group icon, the name and count. */
function TabLabel(props: {
  tab: SidebarGroupTab;
  project: EnvironmentProject | null;
  /** False when the tab does not fit whole: the name keeps the room, and the tooltip the count. */
  showCount?: boolean;
}) {
  const { tab, project } = props;
  const single = tab.singleThread;
  return (
    <>
      {single !== null && project !== null ? (
        <ProjectFavicon project={project} className="size-3.5 shrink-0" />
      ) : null}
      <TabIcon tab={tab} />
      {single !== null ? (
        <span className={cn(THREAD_CARD_TITLE_CLASS, "max-w-36 min-w-0 truncate text-xs")}>
          {single.title}
        </span>
      ) : (
        <>
          {tab.showName ? <span className="max-w-32 min-w-8 truncate">{tab.name}</span> : null}
          {props.showCount === false ? null : (
            <span className="shrink-0 text-muted-foreground/80 tabular-nums">
              {tab.threadCount}
            </span>
          )}
        </>
      )}
    </>
  );
}

const TAB_BOX_CLASS = "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs";
const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToParentElement];

function tabTooltip(tab: SidebarGroupTab) {
  const statusLabel = tab.status === null ? "" : `, ${tab.status.label}`;
  return tab.singleThread === null
    ? `${tab.name}: ${tab.threadCount} threads${statusLabel}`
    : `${tab.singleThread.title} (${tab.name})${statusLabel}`;
}

function GroupTab(props: {
  tab: SidebarGroupTab;
  selected: boolean;
  dropTarget: boolean;
  /** The bar is narrower than this tab, which then shows its name without the count. */
  squeezed: boolean;
  project: EnvironmentProject | null;
  routeThreadKey: string | null;
  /** The tab can move by drag. The first tab stays first, and touch layouts do not reorder. */
  sortable: boolean;
  onSelect: () => void;
  onOpenThread: (thread: SidebarThreadSummary) => void;
  onEdit: (anchor: HTMLElement) => void;
}) {
  const { tab, selected, dropTarget } = props;
  const [element, setElement] = useState<HTMLButtonElement | null>(null);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    disabled: !props.sortable,
  });
  useAttentionWiggle(element, tab.needsAttention ? (tab.status?.kind ?? null) : null);
  const single = tab.singleThread;
  const singleActive =
    single !== null && props.routeThreadKey === `${single.environmentId}:${single.id}`;
  const tooltip = tabTooltip(tab);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={(node) => {
              setElement(node);
              setNodeRef(node);
            }}
            {...listeners}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            type="button"
            role="tab"
            aria-selected={selected}
            // Hooks for theme CSS: the tab, its state, and the status of its most urgent thread.
            data-sidebar-group-tab={tab.isDefault ? "default" : "group"}
            data-selected={selected ? "" : undefined}
            data-status={tab.status?.kind}
            data-attention={tab.needsAttention ? "" : undefined}
            data-drop-target={dropTarget ? "" : undefined}
            data-dragging={isDragging ? "" : undefined}
            aria-label={tooltip}
            {...{ [SIDEBAR_GROUP_DROP_ATTRIBUTE]: tab.id }}
            className={cn(
              // A tab can shrink a little and end its name with an ellipsis, so a rounding error
              // of the fit never cuts it mid-word.
              TAB_BOX_CLASS,
              "min-w-0 shrink cursor-pointer outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              single !== null
                ? singleActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-row-hover"
                : selected
                  ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                  : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              tab.needsAttention && "bg-current/8 ring-1 ring-inset ring-current/30",
              tab.needsAttention && tab.status?.className,
              dropTarget && "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40",
              isDragging && "z-10 opacity-80",
            )}
            onClick={() => (single === null ? props.onSelect() : props.onOpenThread(single))}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onEdit(event.currentTarget);
            }}
          />
        }
      >
        <TabLabel tab={tab} project={props.project} showCount={!props.squeezed} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The tabs that do not fit the bar. A drag over the button opens the menu, so a hidden tab still
 * takes a dropped thread.
 */
function MoreTabsMenu(props: {
  tabs: readonly SidebarGroupTab[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dropTargetId: string | null;
  projectFor: (thread: SidebarThreadSummary) => EnvironmentProject | null;
  onSelect: (tab: SidebarGroupTab) => void;
}) {
  // The button carries the color of a hidden tab that needs the user.
  const attention = props.tabs.find((tab) => tab.needsAttention) ?? null;
  const label = `${props.tabs.length} more ${props.tabs.length === 1 ? "group" : "groups"}`;
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-sidebar-group-more=""
            data-attention={attention !== null ? "" : undefined}
            data-drop-target={props.dropTargetId === SIDEBAR_GROUP_DROP_MORE ? "" : undefined}
            {...{ [SIDEBAR_GROUP_DROP_ATTRIBUTE]: SIDEBAR_GROUP_DROP_MORE }}
            className={cn(
              TAB_BOX_CLASS,
              "shrink-0 cursor-pointer gap-0.5 text-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              attention !== null && "bg-current/8 ring-1 ring-inset ring-current/30",
              attention?.status?.className,
              props.dropTargetId === SIDEBAR_GROUP_DROP_MORE &&
                "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40",
            )}
          />
        }
      >
        <span className="tabular-nums">+{props.tabs.length}</span>
        <AppIcon slot="groups.more" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {props.tabs.map((tab) => (
          <MenuItem
            key={tab.id}
            {...{ [SIDEBAR_GROUP_DROP_ATTRIBUTE]: tab.id }}
            onClick={() => props.onSelect(tab)}
          >
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                props.dropTargetId === tab.id && "text-primary",
              )}
            >
              <TabLabel
                tab={tab}
                project={tab.singleThread === null ? null : props.projectFor(tab.singleThread)}
              />
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The width that each tab needs, from an invisible copy of the tabs, and the width that the bar
 * has. Both update with the tabs and with the sidebar width.
 */
function useTabWidths(tabIds: readonly string[]) {
  const tabCount = tabIds.length;
  // The copies re-render as new elements when the set of tabs changes.
  const tabIdsKey = tabIds.join("\n");
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [measureElement, setMeasureElement] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [gap, setGap] = useState(0);
  const [widths, setWidths] = useState<readonly number[]>([]);
  useEffect(() => {
    if (listElement === null) return;
    return observeResize(listElement, (entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) return;
      setAvailable(entry.contentRect.width);
      // A theme can change the gap between tabs.
      setGap(Number.parseFloat(getComputedStyle(listElement).columnGap) || 0);
    });
  }, [listElement]);
  // The copies of the tabs change size when a name, count or status changes. The observer
  // reports each change, and `observeResize` commits it before paint, so a tab that does not
  // fit never flashes in the bar. Sidebar renders that change nothing measure nothing.
  useEffect(() => {
    if (measureElement === null) return;
    const children = Array.from(measureElement.children);
    return observeResize(children, () => {
      // The layout width: a theme can rotate a tab, which must not widen its slot.
      const next = children.map((child) => (child instanceof HTMLElement ? child.offsetWidth : 0));
      setWidths((current) =>
        current.length === next.length && current.every((width, index) => width === next[index])
          ? current
          : next,
      );
    });
  }, [measureElement, tabIdsKey]);
  // The last measured child is a sample of the "more" button.
  const measured = widths.length === tabCount + 1;
  return {
    setListElement,
    setMeasureElement,
    available: measured ? available : null,
    gap,
    tabWidths: measured ? widths.slice(0, tabCount) : null,
    moreWidth: measured ? widths[tabCount]! : 0,
  };
}

export function SidebarGroupTabs(props: {
  groups: SidebarGroupsState;
  /** A thread drag is in progress, so the "New group" button takes a drop. */
  dragging: boolean;
  routeThreadKey: string | null;
  projectFor: (thread: SidebarThreadSummary) => EnvironmentProject | null;
  onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  const { groups: state } = props;
  const groups = state.settings.groups;
  const [editing, setEditing] = useState<{ groupId: string; anchor: HTMLElement } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const editingDefault = editing?.groupId === DEFAULT_SIDEBAR_GROUP_ID;
  const editingGroup =
    editing === null ? null : (groups.find((group) => group.id === editing.groupId) ?? null);
  const selected = state.tabs.find((tab) => tab.id === state.tabId) ?? null;

  const { setListElement, setMeasureElement, available, gap, tabWidths, moreWidth } = useTabWidths(
    state.tabs.map((tab) => tab.id),
  );
  const visibleIndexes = useMemo(
    () =>
      available === null || tabWidths === null
        ? state.tabs.map((_, index) => index)
        : fitSidebarGroupTabs({
            widths: tabWidths,
            available,
            gap,
            moreWidth,
            selectedIndex: state.tabs.findIndex((tab) => tab.id === state.tabId),
          }),
    [available, gap, moreWidth, state.tabId, state.tabs, tabWidths],
  );
  const visibleTabs = visibleIndexes.map((index) => state.tabs[index]!);
  const hiddenTabs = state.tabs.filter((_, index) => !visibleIndexes.includes(index));
  // At the narrowest sidebar the open tab alone can be wider than the bar. The fit keeps it anyway.
  const squeezedIndex =
    visibleIndexes.length === 1 &&
    available !== null &&
    tabWidths !== null &&
    tabWidths[visibleIndexes[0]!]! > available - (hiddenTabs.length > 0 ? moreWidth + gap : 0)
      ? visibleIndexes[0]!
      : null;

  // A drag over the "more" button opens its menu, and the end of that drag closes it again.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreOpenedByDragRef = useRef(false);
  useEffect(() => {
    if (state.dropTargetId !== SIDEBAR_GROUP_DROP_MORE) return;
    moreOpenedByDragRef.current = true;
    setMoreOpen(true);
  }, [state.dropTargetId]);
  useEffect(() => {
    if (props.dragging || !moreOpenedByDragRef.current) return;
    moreOpenedByDragRef.current = false;
    setMoreOpen(false);
  }, [props.dragging]);

  // Drag a tab to reorder the groups. Not on the mobile layout, where a drag scrolls.
  const reorderable = !useSidebar().isMobile;
  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const sortableTabIds = visibleTabs.filter((tab) => !tab.isDefault).map((tab) => tab.id);
  const reorderTabs = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const toIndex = groups.findIndex((group) => group.id === over.id);
    if (toIndex !== -1) state.moveGroup(String(active.id), toIndex);
  };

  const newGroupTarget = state.dropTargetId === SIDEBAR_GROUP_DROP_NEW;
  return (
    <div ref={barRef} className="flex items-center gap-1 px-2 pb-1.5">
      <div
        ref={setListElement}
        role="tablist"
        aria-label="Thread groups"
        data-sidebar-group-tabs=""
        className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        <DndContext sensors={reorderSensors} modifiers={TAB_DRAG_MODIFIERS} onDragEnd={reorderTabs}>
          <SortableContext items={sortableTabIds} strategy={horizontalListSortingStrategy}>
            {visibleTabs.map((tab) => (
              <GroupTab
                key={tab.id}
                tab={tab}
                selected={tab.id === state.tabId}
                dropTarget={state.dropTargetId === tab.id}
                squeezed={squeezedIndex !== null && state.tabs[squeezedIndex] === tab}
                project={tab.singleThread === null ? null : props.projectFor(tab.singleThread)}
                routeThreadKey={props.routeThreadKey}
                sortable={reorderable && !tab.isDefault}
                onSelect={() => state.setTabId(tab.id)}
                onOpenThread={props.onOpenThread}
                onEdit={(anchor) => setEditing({ groupId: tab.id, anchor })}
              />
            ))}
          </SortableContext>
        </DndContext>
        {hiddenTabs.length > 0 ? (
          <MoreTabsMenu
            tabs={hiddenTabs}
            open={moreOpen}
            onOpenChange={setMoreOpen}
            dropTargetId={state.dropTargetId}
            projectFor={props.projectFor}
            onSelect={(tab) =>
              tab.singleThread === null
                ? state.setTabId(tab.id)
                : props.onOpenThread(tab.singleThread)
            }
          />
        ) : null}
        {/* The widths of every tab and of the "more" button, at their natural size. */}
        <div
          ref={setMeasureElement}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 flex"
        >
          {/* Each copy carries the theme hooks of a selected tab, so theme CSS sizes it too. */}
          {state.tabs.map((tab) => (
            <span
              key={tab.id}
              data-sidebar-group-tab={tab.isDefault ? "default" : "group"}
              data-selected=""
              className={cn(TAB_BOX_CLASS, "shrink-0 font-medium")}
            >
              <TabLabel
                tab={tab}
                project={tab.singleThread === null ? null : props.projectFor(tab.singleThread)}
              />
            </span>
          ))}
          <span data-sidebar-group-more="" className={cn(TAB_BOX_CLASS, "shrink-0 gap-0.5")}>
            <span className="tabular-nums">+{state.tabs.length}</span>
            <AppIcon slot="groups.more" className="size-3.5" />
          </span>
        </div>
      </div>
      {selected !== null ? (
        <SidebarHeaderIconButton
          label={`Edit group ${selected.name}`}
          onClick={(event) => setEditing({ groupId: selected.id, anchor: event.currentTarget })}
        >
          <AppIcon slot="groups.edit" />
        </SidebarHeaderIconButton>
      ) : null}
      {/* Outside the tabs, so it stays in view. During a drag the same slot takes a drop for a
          new group, at the same size, so the tabs do not reflow. */}
      {props.dragging ? (
        <div
          aria-label="Drop here for a new group"
          data-sidebar-group-new=""
          data-drop-target={newGroupTarget ? "" : undefined}
          {...{ [SIDEBAR_GROUP_DROP_ATTRIBUTE]: SIDEBAR_GROUP_DROP_NEW }}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground",
            newGroupTarget && "border-primary/60 bg-primary/10 text-primary",
          )}
        >
          <AppIcon slot="groups.new" />
        </div>
      ) : (
        <SidebarHeaderIconButton
          label="New group"
          disabled={!state.ready}
          onClick={() => {
            const id = state.createGroup([]);
            // The new tab renders on the next frame; anchor the editor to the bar until then.
            if (id !== null && barRef.current !== null) {
              setEditing({ groupId: id, anchor: barRef.current });
            }
          }}
        >
          <AppIcon slot="groups.new" />
        </SidebarHeaderIconButton>
      )}
      <Popover
        open={editing !== null && (editingGroup !== null || editingDefault)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <PopoverPopup anchor={editing?.anchor ?? null} width="md" align="start" padding="compact">
          {editingDefault ? (
            <SidebarDefaultTabEditor
              defaultTab={state.settings.defaultTab}
              onChange={(update) => state.setDefaultTab(update)}
            />
          ) : editingGroup === null ? null : (
            <SidebarGroupEditor
              // Keyed by group, so a name typed for one group never renames another.
              key={editingGroup.id}
              group={editingGroup}
              index={groups.indexOf(editingGroup)}
              groupCount={groups.length}
              ruleOptions={(field) => state.ruleOptions(field, editingGroup.id)}
              onRename={(name) => state.renameGroup(editingGroup.id, name)}
              onSetLook={(look) => state.setGroupLook(editingGroup.id, look)}
              onSetRules={(rules) => state.setGroupRules(editingGroup.id, rules)}
              onMove={(toIndex) => state.moveGroup(editingGroup.id, toIndex)}
              onDelete={() => {
                setEditing(null);
                state.deleteGroup(editingGroup.id);
              }}
            />
          )}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function ruleValueLabel(rule: SidebarGroupRule, options: readonly SidebarGroupRuleOption[]) {
  return rule.values
    .map((value) =>
      rule.field === "title"
        ? `"${value ?? ""}"`
        : (options.find((option) => option.value === value)?.label ?? value ?? "None"),
    )
    .join(", ");
}

/** React keys for rules, which have no id. Equal rules get a counter. */
function ruleKeys(rules: readonly SidebarGroupStoredRule[]): string[] {
  const seen = new Map<string, number>();
  return rules.map((rule) => {
    const base = `${rule.field}:${rule.operator}:${rule.values.map((value) => value ?? "").join("|")}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}#${count}`;
  });
}

function RuleChip(props: {
  rule: SidebarGroupStoredRule;
  ruleOptions: (field: Exclude<SidebarGroupRuleField, "title">) => SidebarGroupRuleOption[];
  onChange: (rule: SidebarGroupRule) => void;
  onRemove: () => void;
}) {
  const { rule, onRemove } = props;
  // A rule from a newer T3 version: this version skips it, and it can only go.
  if (!isKnownSidebarGroupRule(rule)) {
    return (
      <FilterChip field="Rule" operator={null} value="from a newer version" onRemove={onRemove} />
    );
  }
  const field = sidebarGroupRuleFieldLabel(rule.field);
  if (isAnyGroupRule(rule)) {
    return <FilterChip field={field} operator={null} value="any" onRemove={onRemove} />;
  }
  if (rule.field === "title") {
    // A title rule reads as a sentence of its own: "Title: contains "fork"".
    const verb = rule.operator === "is" ? "contains" : "does not contain";
    return (
      <FilterChip
        field={field}
        operator={null}
        value={`${verb} ${ruleValueLabel(rule, [])}`}
        onRemove={onRemove}
      />
    );
  }
  return (
    <FilterChip
      field={field}
      operator={rule.operator}
      value={ruleValueLabel(rule, props.ruleOptions(rule.field))}
      onFlip={() => props.onChange({ ...rule, operator: flipFilterOperator(rule.operator) })}
      onRemove={onRemove}
    />
  );
}

function SidebarGroupEditor(props: {
  group: SidebarGroup;
  index: number;
  groupCount: number;
  ruleOptions: (field: Exclude<SidebarGroupRuleField, "title">) => SidebarGroupRuleOption[];
  onRename: (name: string) => void;
  onSetLook: (look: TabLook) => void;
  onSetRules: (rules: SidebarGroup["rules"]) => void;
  onMove: (toIndex: number) => void;
  onDelete: () => void;
}) {
  const { group } = props;
  const [name, setName] = useState(group.name);
  const [titleText, setTitleText] = useState("");
  const toggleValue = (field: SidebarGroupRuleField, value: string | null, checked: boolean) =>
    props.onSetRules(toggleSidebarGroupRuleValue(group.rules, field, value, checked));
  // The name the editor saved last, so a blur and the close that follows save once.
  const savedName = useRef(group.name);
  const deleted = useRef(false);
  const commitName = () => {
    const trimmed = name.trim();
    if (deleted.current || trimmed.length === 0 || trimmed === savedName.current) return;
    savedName.current = trimmed;
    props.onRename(trimmed);
  };
  // Closing the popover unmounts the input without a blur, so the name also saves on close.
  const commitNameOnClose = useEffectEvent(commitName);
  useEffect(() => () => commitNameOnClose(), []);
  const knownRules = group.rules.filter(isKnownSidebarGroupRule);
  const isView = knownRules.some((rule) => rule.field === "group");
  const keys = ruleKeys(group.rules);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Input
        size="sm"
        value={name}
        aria-label="Group name"
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitName();
        }}
      />
      <TabLookEditor look={group} onChange={props.onSetLook} />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          {knownRules.length === 0
            ? "No rules. The group holds the threads that you drag into it."
            : isView
              ? "A view: it shows the threads of other groups that match every rule."
              : "Holds every thread that matches every rule, and the threads that you drag into it."}
        </span>
        <div className="flex flex-wrap gap-1">
          {group.rules.map((rule, index) => (
            <RuleChip
              key={keys[index]}
              rule={rule}
              ruleOptions={props.ruleOptions}
              onChange={(next) =>
                props.onSetRules(
                  group.rules.map((current, candidate) => (candidate === index ? next : current)),
                )
              }
              onRemove={() =>
                props.onSetRules(group.rules.filter((_, candidate) => candidate !== index))
              }
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Menu>
          <MenuTrigger render={<Button variant="outline" size="xs" />}>
            <PlusIcon />
            Add rule
          </MenuTrigger>
          <MenuPopup align="start">
            {SIDEBAR_GROUP_RULE_FIELDS.filter(
              (field): field is Exclude<SidebarGroupRuleField, "title"> => field !== "title",
            ).map((field) => (
              <MenuSub key={field}>
                <MenuSubTrigger>{sidebarGroupRuleFieldLabel(field)}</MenuSubTrigger>
                <MenuSubPopup className="max-h-80 max-w-64 overflow-y-auto">
                  {field === "group" ? (
                    <MenuItem
                      onClick={() =>
                        props.onSetRules([
                          ...group.rules.filter((rule) => rule.field !== "group"),
                          { field: "group", operator: "is_not", values: [] },
                        ])
                      }
                    >
                      Any group (shows every thread)
                    </MenuItem>
                  ) : null}
                  {props.ruleOptions(field).map((option) => (
                    <MenuCheckboxItem
                      key={option.value ?? ""}
                      checked={knownRules.some(
                        (rule) => rule.field === field && rule.values.includes(option.value),
                      )}
                      onCheckedChange={(checked) => toggleValue(field, option.value, checked)}
                    >
                      <span className="min-w-0 truncate">{option.label}</span>
                    </MenuCheckboxItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ))}
          </MenuPopup>
        </Menu>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const text = titleText.trim();
            if (text.length === 0) return;
            toggleValue("title", text, true);
            setTitleText("");
          }}
        >
          <Input
            size="sm"
            value={titleText}
            placeholder="Title contains…"
            aria-label="Add a title rule"
            onChange={(event) => setTitleText(event.target.value)}
          />
        </form>
      </div>
      <EditorFooter>
        <Button
          variant="ghost"
          size="xs"
          disabled={props.index <= 0}
          onClick={() => props.onMove(props.index - 1)}
        >
          Move left
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={props.index >= props.groupCount - 1}
          onClick={() => props.onMove(props.index + 1)}
        >
          Move right
        </Button>
        <Button
          variant="destructive"
          size="xs"
          className="ms-auto"
          onClick={() => {
            deleted.current = true;
            props.onDelete();
          }}
        >
          Delete group
        </Button>
      </EditorFooter>
    </div>
  );
}

type TabLook = { readonly icon?: string; readonly showName?: boolean };

/**
 * The icon and the name of a tab. `none` hides the icon. Without a choice the tab shows the
 * dot. The icons come from `AppIcon`, so a theme icon pack shows here too.
 */
function TabLookEditor(props: {
  look: { readonly icon?: string | undefined; readonly showName?: boolean | undefined };
  onChange: (look: TabLook) => void;
}) {
  const current = props.look.icon ?? "dot";
  const showName = props.look.showName !== false;
  const choice = (id: string, label: string, icon: ReactNode) => (
    <Tooltip key={id}>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="radio"
            aria-checked={current === id}
            aria-label={label}
            className={cn(
              "flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              current === id && "bg-accent text-foreground ring-1 ring-inset ring-ring",
            )}
            onClick={() => props.onChange({ icon: id })}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Tab icon" className="grid grid-cols-9 gap-0.5">
        {GROUP_ICON_IDS.map((id) => choice(id, id === "dot" ? "Dot" : id, <GroupIcon icon={id} />))}
        {choice("none", "No icon", <BanIcon aria-hidden className="size-4" />)}
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        Show the name on the tab
        <Switch
          size="sm"
          checked={showName}
          onCheckedChange={(checked) => props.onChange({ showName: Boolean(checked) })}
        />
      </label>
    </div>
  );
}

/** The first tab: its name and look, and whether it shows every thread or the ungrouped ones. */
function SidebarDefaultTabEditor(props: {
  defaultTab: SidebarGroups["defaultTab"];
  onChange: (update: (tab: SidebarGroups["defaultTab"]) => SidebarGroups["defaultTab"]) => void;
}) {
  const { defaultTab } = props;
  const [name, setName] = useState(defaultTab.name ?? "");
  const savedName = useRef(defaultTab.name ?? "");
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === savedName.current) return;
    savedName.current = trimmed;
    props.onChange(({ name: _name, ...rest }) =>
      trimmed.length === 0 ? rest : { ...rest, name: trimmed },
    );
  };
  // Closing the popover unmounts the input without a blur.
  const commitNameOnClose = useEffectEvent(commitName);
  useEffect(() => () => commitNameOnClose(), []);
  const showsAll = defaultTab.show === "all";
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Input
        size="sm"
        value={name}
        placeholder={DEFAULT_SIDEBAR_GROUP_NAME}
        aria-label="First tab name"
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitName();
        }}
      />
      <TabLookEditor
        look={defaultTab}
        onChange={(look) => props.onChange((tab) => ({ ...tab, ...look }))}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">This tab shows</span>
        <div className="flex gap-1">
          <Button
            variant={showsAll ? "ghost" : "secondary"}
            size="xs"
            onClick={() => props.onChange((tab) => ({ ...tab, show: "ungrouped" }))}
          >
            Threads in no group
          </Button>
          <Button
            variant={showsAll ? "secondary" : "ghost"}
            size="xs"
            onClick={() => props.onChange((tab) => ({ ...tab, show: "all" }))}
          >
            All threads
          </Button>
        </div>
      </div>
    </div>
  );
}

function EditorFooter(props: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1 border-t border-border pt-2">{props.children}</div>
  );
}
