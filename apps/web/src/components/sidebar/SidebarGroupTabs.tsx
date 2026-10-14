/**
 * Fork: the tab bar of sidebar thread groups, under the Search field. Each tab is a group: a view
 * with rules over the same threads. Drop a thread on a tab to move it there, or on the empty end
 * of the bar to make a new group.
 */
import type { SidebarGroup, SidebarGroupRule, SidebarGroupRuleField } from "@t3tools/contracts";
import { FolderIcon, InboxIcon, LayersIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarThreadSummary } from "../../types";
import { FilterChip, flipFilterOperator } from "../filters/FilterChip";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  SIDEBAR_GROUP_RULE_FIELDS,
  sidebarGroupRuleFieldLabel,
  type SidebarGroupRuleOption,
} from "./sidebarGroups.logic";
import { ThreadCardStatusGlyph, THREAD_CARD_TITLE_CLASS } from "./threadCardParts";
import type { SidebarGroupTab } from "./useSidebarGroups";

/** The data attribute that marks a drop target in the tab bar: a tab id, or `new`. */
export const SIDEBAR_GROUP_DROP_ATTRIBUTE = "data-sidebar-group-drop";
export const SIDEBAR_GROUP_DROP_NEW = "new";

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

function TabIcon(props: { tab: SidebarGroupTab }) {
  const { tab } = props;
  if (tab.status !== null) {
    // Waiting has no icon on a row, where its label carries it. A tab shows no label.
    const icon = tab.status.card.icon ?? "waiting";
    return (
      <ThreadCardStatusGlyph icon={icon} className={cn("size-3.5", tab.status.card.className)} />
    );
  }
  const Icon = tab.isDefault ? InboxIcon : tab.isView ? LayersIcon : FolderIcon;
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

function GroupTab(props: {
  tab: SidebarGroupTab;
  selected: boolean;
  dropTarget: boolean;
  project: EnvironmentProject | null;
  routeThreadKey: string | null;
  onSelect: () => void;
  onOpenThread: (thread: SidebarThreadSummary) => void;
  onEdit: (anchor: HTMLElement) => void;
}) {
  const { tab, selected, dropTarget, project } = props;
  const [element, setElement] = useState<HTMLButtonElement | null>(null);
  useAttentionWiggle(element, tab.needsAttention ? (tab.status?.kind ?? null) : null);
  const single = tab.singleThread;
  const singleActive =
    single !== null && props.routeThreadKey === `${single.environmentId}:${single.id}`;
  const statusLabel = tab.status === null ? "" : `, ${tab.status.card.label}`;
  const tooltip =
    single === null
      ? `${tab.name}: ${tab.threadCount} threads${statusLabel}`
      : `${single.title} (${tab.name})${statusLabel}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={setElement}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={tooltip}
            {...{ [SIDEBAR_GROUP_DROP_ATTRIBUTE]: tab.id }}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              single !== null
                ? singleActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-row-hover"
                : selected
                  ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                  : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              tab.needsAttention && "bg-current/8 ring-1 ring-inset ring-current/30",
              tab.needsAttention && tab.status?.card.className,
              dropTarget && "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40",
            )}
            onClick={() => (single === null ? props.onSelect() : props.onOpenThread(single))}
            onContextMenu={(event) => {
              if (tab.isDefault) return;
              event.preventDefault();
              props.onEdit(event.currentTarget);
            }}
          />
        }
      >
        {single !== null && project !== null ? (
          <ProjectFavicon project={project} className="size-3.5 shrink-0" />
        ) : null}
        <TabIcon tab={tab} />
        {single !== null ? (
          <span className={cn(THREAD_CARD_TITLE_CLASS, "max-w-36 truncate text-xs")}>
            {single.title}
          </span>
        ) : (
          <>
            <span className="max-w-32 truncate">{tab.name}</span>
            <span className="text-muted-foreground/80 tabular-nums">{tab.threadCount}</span>
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarGroupTabs(props: {
  tabs: readonly SidebarGroupTab[];
  selectedTabId: string;
  /** A thread drag is in progress, so the empty end of the bar offers a new group. */
  dragging: boolean;
  dropTargetId: string | null;
  groups: readonly SidebarGroup[];
  routeThreadKey: string | null;
  projectFor: (thread: SidebarThreadSummary) => EnvironmentProject | null;
  ruleOptions: (
    field: Exclude<SidebarGroupRuleField, "title">,
    groupId: string,
  ) => SidebarGroupRuleOption[];
  onSelect: (tabId: string) => void;
  onOpenThread: (thread: SidebarThreadSummary) => void;
  onCreateGroup: () => string;
  onRenameGroup: (groupId: string, name: string) => void;
  onSetGroupRules: (groupId: string, rules: readonly SidebarGroupRule[]) => void;
  onDeleteGroup: (groupId: string) => void;
  onMoveGroup: (groupId: string, toIndex: number) => void;
}) {
  const [editing, setEditing] = useState<{ groupId: string; anchor: HTMLElement } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const editingGroup =
    editing === null ? null : (props.groups.find((group) => group.id === editing.groupId) ?? null);
  const selected = props.tabs.find((tab) => tab.id === props.selectedTabId) ?? null;
  return (
    <div className="flex items-center gap-1 px-2 pb-1.5">
      <div
        ref={barRef}
        role="tablist"
        aria-label="Thread groups"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {props.tabs.map((tab) => (
          <GroupTab
            key={tab.id}
            tab={tab}
            selected={tab.id === props.selectedTabId}
            dropTarget={props.dropTargetId === tab.id}
            project={tab.singleThread === null ? null : props.projectFor(tab.singleThread)}
            routeThreadKey={props.routeThreadKey}
            onSelect={() => props.onSelect(tab.id)}
            onOpenThread={props.onOpenThread}
            onEdit={(anchor) => setEditing({ groupId: tab.id, anchor })}
          />
        ))}
        <div
          {...{ [SIDEBAR_GROUP_DROP_ATTRIBUTE]: SIDEBAR_GROUP_DROP_NEW }}
          className={cn(
            "flex h-7 min-w-16 flex-1 items-center rounded-md px-2 text-xs",
            props.dragging && "border border-dashed border-border text-muted-foreground",
            props.dropTargetId === SIDEBAR_GROUP_DROP_NEW &&
              "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          {props.dragging ? (
            <span className="inline-flex items-center gap-1 truncate">
              <PlusIcon aria-hidden className="size-3.5" />
              New group
            </span>
          ) : null}
        </div>
      </div>
      {selected !== null && !selected.isDefault ? (
        <SidebarHeaderIconButton
          label={`Edit group ${selected.name}`}
          onClick={(event) => setEditing({ groupId: selected.id, anchor: event.currentTarget })}
        >
          <SlidersHorizontalIcon />
        </SidebarHeaderIconButton>
      ) : null}
      <SidebarHeaderIconButton
        label="New group"
        onClick={() => {
          const id = props.onCreateGroup();
          // The new tab renders on the next frame; anchor the editor to the bar until then.
          if (barRef.current !== null) setEditing({ groupId: id, anchor: barRef.current });
        }}
      >
        <PlusIcon />
      </SidebarHeaderIconButton>
      <Popover
        open={editing !== null && editingGroup !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <PopoverPopup anchor={editing?.anchor ?? null} width="md" align="start" padding="compact">
          {editingGroup === null ? null : (
            <SidebarGroupEditor
              group={editingGroup}
              index={props.groups.indexOf(editingGroup)}
              groupCount={props.groups.length}
              ruleOptions={(field) => props.ruleOptions(field, editingGroup.id)}
              onRename={(name) => props.onRenameGroup(editingGroup.id, name)}
              onSetRules={(rules) => props.onSetGroupRules(editingGroup.id, rules)}
              onMove={(toIndex) => props.onMoveGroup(editingGroup.id, toIndex)}
              onDelete={() => {
                setEditing(null);
                props.onDeleteGroup(editingGroup.id);
              }}
            />
          )}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function ruleValueLabel(rule: SidebarGroupRule, options: readonly SidebarGroupRuleOption[]) {
  if (rule.values.length === 0) return "nothing";
  return rule.values
    .map((value) =>
      rule.field === "title"
        ? `"${value ?? ""}"`
        : (options.find((option) => option.value === value)?.label ?? value ?? "None"),
    )
    .join(", ");
}

// Rules have no id. A group rarely holds two equal rules, and a clash only costs a remount.
const ruleKey = (rule: SidebarGroupRule) =>
  `${rule.field}:${rule.operator}:${rule.values.map((value) => value ?? "").join("|")}`;

/** "Group is not (nothing)": the rule of an "All" view. */
const isAnyGroupRule = (rule: SidebarGroupRule) =>
  rule.field === "group" && rule.operator === "is_not" && rule.values.length === 0;

function SidebarGroupEditor(props: {
  group: SidebarGroup;
  index: number;
  groupCount: number;
  ruleOptions: (field: Exclude<SidebarGroupRuleField, "title">) => SidebarGroupRuleOption[];
  onRename: (name: string) => void;
  onSetRules: (rules: readonly SidebarGroupRule[]) => void;
  onMove: (toIndex: number) => void;
  onDelete: () => void;
}) {
  const { group } = props;
  const [name, setName] = useState(group.name);
  const [titleText, setTitleText] = useState("");
  const setRule = (index: number, rule: SidebarGroupRule | null) =>
    props.onSetRules(
      rule === null
        ? group.rules.filter((_, candidate) => candidate !== index)
        : group.rules.map((current, candidate) => (candidate === index ? rule : current)),
    );
  // One rule per field: picking values in the menu edits that rule.
  const toggleValue = (field: SidebarGroupRuleField, value: string | null, checked: boolean) => {
    const index = group.rules.findIndex((rule) => rule.field === field);
    const current = index === -1 ? null : group.rules[index]!;
    const values = checked
      ? [...(current?.values ?? []), value]
      : (current?.values ?? []).filter((candidate) => candidate !== value);
    if (current === null) {
      props.onSetRules([...group.rules, { field, operator: "is", values }]);
    } else {
      setRule(index, { ...current, values });
    }
  };
  const commitName = () => {
    if (name.trim().length > 0 && name.trim() !== group.name) props.onRename(name);
  };
  const isView = group.rules.some((rule) => rule.field === "group");
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
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          {group.rules.length === 0
            ? "No rules. The group holds the threads that you drag into it."
            : isView
              ? "A view: it shows the threads of other groups that match every rule."
              : "Holds every thread that matches every rule, and the threads that you drag into it."}
        </span>
        <div className="flex flex-wrap gap-1">
          {group.rules.map((rule, index) =>
            isAnyGroupRule(rule) ? (
              <FilterChip
                key={ruleKey(rule)}
                field={sidebarGroupRuleFieldLabel(rule.field)}
                operator={null}
                value="any"
                onRemove={() => setRule(index, null)}
              />
            ) : rule.field === "title" ? (
              // A title rule reads as a sentence of its own: "Title: contains "fork"".
              <FilterChip
                key={ruleKey(rule)}
                field={sidebarGroupRuleFieldLabel(rule.field)}
                operator={null}
                value={`${rule.operator === "is" ? "contains" : "does not contain"} ${ruleValueLabel(rule, [])}`}
                onRemove={() => setRule(index, null)}
              />
            ) : (
              <FilterChip
                key={ruleKey(rule)}
                field={sidebarGroupRuleFieldLabel(rule.field)}
                operator={rule.operator}
                value={ruleValueLabel(rule, props.ruleOptions(rule.field))}
                onFlip={() =>
                  setRule(index, { ...rule, operator: flipFilterOperator(rule.operator) })
                }
                onRemove={() => setRule(index, null)}
              />
            ),
          )}
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
                      checked={group.rules.some(
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
        <Button variant="ghost-destructive" size="xs" className="ms-auto" onClick={props.onDelete}>
          Delete group
        </Button>
      </EditorFooter>
    </div>
  );
}

function EditorFooter(props: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1 border-t border-border pt-2">{props.children}</div>
  );
}

/** The group drop target under a point: a tab id, `new`, or null. */
export function sidebarGroupDropTargetAt(point: { x: number; y: number }): string | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest(`[${SIDEBAR_GROUP_DROP_ATTRIBUTE}]`)
      ?.getAttribute(SIDEBAR_GROUP_DROP_ATTRIBUTE) ?? null
  );
}
