/**
 * Fork: icons that a theme can replace. Each slot has a stock lucide icon. A published theme can
 * carry an icon pack (`icons` in its JSON, slot to SVG), and `AppIcon` then draws the theme's SVG
 * in place of the stock icon. Theme SVGs are sanitized before they render.
 */
import DOMPurify from "dompurify";
import {
  AlarmClockIcon,
  ArchiveIcon,
  BellIcon,
  BookIcon,
  BookmarkIcon,
  BotIcon,
  BoxIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  CloudIcon,
  CodeIcon,
  DatabaseIcon,
  EyeIcon,
  FlagIcon,
  FlameIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GlobeIcon,
  HeartIcon,
  HouseIcon,
  InboxIcon,
  LayersIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  RocketIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  ShieldQuestionIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquarePenIcon,
  StarIcon,
  TagIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useSyncExternalStore, type SVGProps } from "react";

import { cn } from "~/lib/utils";
import { getActiveThemeIcons, subscribeToActiveThemeIcons } from "../themePalette";

/** A filled dot, the default icon of a group. */
function DotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </svg>
  );
}

/** The icons a user can pick for a group, in picker order. `dot` is the default. */
const GROUP_ICONS = {
  dot: DotIcon,
  star: StarIcon,
  heart: HeartIcon,
  bolt: ZapIcon,
  flame: FlameIcon,
  sparkles: SparklesIcon,
  rocket: RocketIcon,
  bug: BugIcon,
  wrench: WrenchIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  bot: BotIcon,
  branch: GitBranchIcon,
  eye: EyeIcon,
  clock: ClockIcon,
  calendar: CalendarIcon,
  bell: BellIcon,
  flag: FlagIcon,
  bookmark: BookmarkIcon,
  tag: TagIcon,
  inbox: InboxIcon,
  archive: ArchiveIcon,
  folder: FolderIcon,
  layers: LayersIcon,
  box: BoxIcon,
  briefcase: BriefcaseIcon,
  home: HouseIcon,
  book: BookIcon,
  globe: GlobeIcon,
  cloud: CloudIcon,
  server: ServerIcon,
  database: DatabaseIcon,
  shield: ShieldIcon,
} as const satisfies Record<string, LucideIcon | typeof DotIcon>;
export type GroupIconId = keyof typeof GROUP_ICONS;

const isGroupIconId = (value: string): value is GroupIconId => Object.hasOwn(GROUP_ICONS, value);

export const GROUP_ICON_IDS: readonly GroupIconId[] =
  Object.keys(GROUP_ICONS).filter(isGroupIconId);

/**
 * The slots besides the group icons, with their stock icons. Thread rows and group tabs draw a
 * thread status with its `status.<kind>` slot.
 */
const STATIC_SLOT_ICONS = {
  "status.working": CircleDashedIcon,
  "status.waiting": CircleDotDashedIcon,
  "status.approval": ShieldQuestionIcon,
  "status.input": MessageCircleQuestionIcon,
  "status.failed": CircleAlertIcon,
  "status.limited": CircleAlertIcon,
  "status.woke": AlarmClockIcon,
  "status.done": CircleCheckIcon,
  "groups.more": ChevronDownIcon,
  "groups.new": PlusIcon,
  "groups.edit": SlidersHorizontalIcon,
  "sidebar.search": SearchIcon,
  "sidebar.filter": ListFilterIcon,
  "sidebar.add-project": FolderPlusIcon,
  "sidebar.new-thread": SquarePenIcon,
} as const satisfies Record<string, LucideIcon>;

/** Every slot a theme icon pack can replace: `group.<id>` and the static slots. */
export type AppIconSlot = `group.${GroupIconId}` | keyof typeof STATIC_SLOT_ICONS;

const isStaticSlot = (slot: string): slot is keyof typeof STATIC_SLOT_ICONS =>
  Object.hasOwn(STATIC_SLOT_ICONS, slot);

function stockIcon(slot: AppIconSlot) {
  if (isStaticSlot(slot)) return STATIC_SLOT_ICONS[slot];
  const id = slot.slice("group.".length);
  return GROUP_ICONS[isGroupIconId(id) ? id : "dot"];
}

let purifier: ReturnType<typeof DOMPurify> | null = null;
const sanitized = new Map<string, string>();

/**
 * A theme SVG with no script, link or remote content. The result is cached by source, because a
 * pack renders the same few icons many times.
 */
function sanitizeThemeIcon(svg: string): string {
  const cached = sanitized.get(svg);
  if (cached !== undefined) return cached;
  purifier ??= DOMPurify(window);
  const clean = purifier.sanitize(svg, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ["a", "image", "script", "foreignObject", "style"],
    FORBID_ATTR: ["href", "xlink:href", "src"],
  });
  sanitized.set(svg, clean);
  return clean;
}

function useActiveThemeIcons() {
  return useSyncExternalStore(
    subscribeToActiveThemeIcons,
    getActiveThemeIcons,
    getActiveThemeIcons,
  );
}

/**
 * The icon of a slot: the active theme's SVG when its pack has the slot, else the stock icon.
 * `data-app-icon` names the slot, so theme CSS can style one icon.
 */
export function AppIcon(props: { slot: AppIconSlot; className?: string | undefined }) {
  const themeSvg = useActiveThemeIcons()[props.slot];
  const className = cn("size-4 shrink-0", props.className);
  if (themeSvg !== undefined) {
    return (
      <span
        aria-hidden
        data-app-icon={props.slot}
        className={cn("inline-flex [&>svg]:size-full", className)}
        // Sanitized: DOMPurify keeps SVG shapes only, without script, links or remote content.
        dangerouslySetInnerHTML={{ __html: sanitizeThemeIcon(themeSvg) }}
      />
    );
  }
  const Icon = stockIcon(props.slot);
  return <Icon aria-hidden data-app-icon={props.slot} className={className} />;
}

/**
 * The icon of a group tab: its chosen icon, the dot when it has none or an unknown id, or
 * nothing for `none`.
 */
export function GroupIcon(props: { icon: string | undefined; className?: string | undefined }) {
  if (props.icon === "none") return null;
  const id = props.icon !== undefined && isGroupIconId(props.icon) ? props.icon : "dot";
  return <AppIcon slot={`group.${id}`} className={props.className} />;
}
