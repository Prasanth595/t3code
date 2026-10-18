/**
 * Fork: the group icons of the sidebar group tabs. The ids are the web ids (`GROUP_ICONS` in web
 * `AppIcon.tsx`), so a group shows the same icon on web and mobile.
 */
import type { Icon } from "@tabler/icons-react-native/types";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconBell from "@tabler/icons-react-native/IconBell";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBookmark from "@tabler/icons-react-native/IconBookmark";
import IconBox from "@tabler/icons-react-native/IconBox";
import IconBriefcase from "@tabler/icons-react-native/IconBriefcase";
import IconBug from "@tabler/icons-react-native/IconBug";
import IconCalendar from "@tabler/icons-react-native/IconCalendar";
import IconClock from "@tabler/icons-react-native/IconClock";
import IconCloud from "@tabler/icons-react-native/IconCloud";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconFlag from "@tabler/icons-react-native/IconFlag";
import IconFlame from "@tabler/icons-react-native/IconFlame";
import IconFolder from "@tabler/icons-react-native/IconFolder";
import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconHeart from "@tabler/icons-react-native/IconHeart";
import IconHome from "@tabler/icons-react-native/IconHome";
import IconInbox from "@tabler/icons-react-native/IconInbox";
import IconPointFilled from "@tabler/icons-react-native/IconPointFilled";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconShield from "@tabler/icons-react-native/IconShield";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStack2 from "@tabler/icons-react-native/IconStack2";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconTag from "@tabler/icons-react-native/IconTag";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import type { ColorValue } from "react-native";

/** The web group icon ids (`GROUP_ICONS` in web `AppIcon.tsx`), with Tabler icons. */
export const GROUP_ICONS: Record<string, Icon> = {
  dot: IconPointFilled,
  star: IconStar,
  heart: IconHeart,
  bolt: IconBolt,
  flame: IconFlame,
  sparkles: IconSparkles,
  rocket: IconRocket,
  bug: IconBug,
  wrench: IconTool,
  code: IconCode,
  terminal: IconTerminal2,
  bot: IconRobot,
  branch: IconGitBranch,
  eye: IconEye,
  clock: IconClock,
  calendar: IconCalendar,
  bell: IconBell,
  flag: IconFlag,
  bookmark: IconBookmark,
  tag: IconTag,
  inbox: IconInbox,
  archive: IconArchive,
  folder: IconFolder,
  layers: IconStack2,
  box: IconBox,
  briefcase: IconBriefcase,
  home: IconHome,
  book: IconBook,
  globe: IconWorld,
  cloud: IconCloud,
  server: IconServer,
  database: IconDatabase,
  shield: IconShield,
};

/** The icon ids in picker order, like web `GROUP_ICON_IDS`. */
export const GROUP_ICON_IDS = Object.keys(GROUP_ICONS);

/** The icon of a tab: a group icon id, the dot without one, or nothing for `none`. */
export function GroupIcon(props: {
  readonly icon: string | undefined;
  readonly size: number;
  readonly color: ColorValue | undefined;
}) {
  if (props.icon === "none") return null;
  const TabIcon = GROUP_ICONS[props.icon ?? "dot"] ?? IconPointFilled;
  return <TabIcon size={props.size} strokeWidth={2} color={props.color} />;
}
