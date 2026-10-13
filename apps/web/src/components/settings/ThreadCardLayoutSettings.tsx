import {
  DEFAULT_MOBILE_THREAD_CARD_LAYOUT,
  DEFAULT_THREAD_CARD_LAYOUT,
  type MobileThreadCardElement,
  type MobileThreadCardLayout,
  REQUIRED_THREAD_CARD_ELEMENTS,
  THREAD_CARD_ELEMENTS,
  type ThreadCardElement,
  type ThreadCardLayout,
  type ThreadCardSurface,
} from "@t3tools/contracts";
import {
  ActivityIcon,
  BotIcon,
  CalendarIcon,
  CircleAlertIcon,
  ClockIcon,
  CpuIcon,
  DiffIcon,
  DotIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  ImageIcon,
  LayersIcon,
  ListTodoIcon,
  LockOpenIcon,
  MessageSquareIcon,
  MonitorIcon,
  PinIcon,
  TargetIcon,
  TerminalIcon,
  TypeIcon,
} from "lucide-react";
import { useState } from "react";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { type SlotLayoutElementOption, SlotLayoutBuilder } from "./SlotLayoutBuilder";
import { ThreadCardLayoutPreview } from "./ThreadCardLayoutPreview";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const ELEMENT_OPTIONS: Record<
  ThreadCardElement,
  Omit<SlotLayoutElementOption<ThreadCardElement>, "id">
> = {
  favicon: { label: "Project icon", icon: ImageIcon },
  project: { label: "Project name", icon: FolderIcon },
  branch: { label: "Branch", icon: GitBranchIcon },
  title: { label: "Title", icon: TypeIcon },
  pin: { label: "Pin", icon: PinIcon },
  status: { label: "Status and actions", icon: ActivityIcon },
  terminal: { label: "Terminal", icon: TerminalIcon },
  pullRequest: { label: "Pull request", icon: PullRequestGlyph.pullRequest },
  diff: { label: "Diff", icon: DiffIcon },
  machine: { label: "Machine", icon: MonitorIcon },
  providers: { label: "Agents", icon: BotIcon },
  model: { label: "Model", icon: CpuIcon },
  access: { label: "Access mode", icon: LockOpenIcon },
  plan: { label: "Plan mode", icon: ListTodoIcon },
  backgroundTasks: { label: "Background tasks", icon: LayersIcon },
  goal: { label: "Goal", icon: TargetIcon },
  lineage: { label: "Forked from", icon: GitForkIcon },
  limitReset: { label: "Limit reset", icon: ClockIcon },
  error: { label: "Error", icon: CircleAlertIcon },
  unread: { label: "Unread dot", icon: DotIcon },
  age: { label: "Age", icon: CalendarIcon },
  messageCount: { label: "Message count", icon: MessageSquareIcon },
};

const DESKTOP_OPTIONS: ReadonlyArray<SlotLayoutElementOption<ThreadCardElement>> =
  THREAD_CARD_ELEMENTS.map((id) => ({ id, ...ELEMENT_OPTIONS[id] }));

const MOBILE_OPTIONS: ReadonlyArray<SlotLayoutElementOption<MobileThreadCardElement>> =
  DESKTOP_OPTIONS.filter(
    (option): option is SlotLayoutElementOption<MobileThreadCardElement> =>
      option.id !== "terminal" && option.id !== "diff",
  );

/** Fork: builds the thread card from its elements, per client surface. Off by default. */
export function ThreadCardLayoutSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadCardLayouts"]);
  const [surface, setSurface] = useState<ThreadCardSurface>("desktop");
  const layouts = settings.threadCardLayouts;
  const layout = layouts[surface];
  const surfaceLabel = surface === "desktop" ? "desktop and web" : "mobile";

  const setDesktop = (next: ThreadCardLayout | null) =>
    updateSettings({ threadCardLayouts: { desktop: next } });
  const setMobile = (next: MobileThreadCardLayout | null) =>
    updateSettings({ threadCardLayouts: { mobile: next } });

  return (
    <SettingsSection id="thread-cards" title="Thread cards">
      <div className="px-4 pt-3">
        <ToggleGroup
          aria-label="Card surface"
          variant="segmented"
          value={[surface]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "desktop" || value === "mobile") setSurface(value);
          }}
        >
          <Toggle value="desktop">Desktop & web</Toggle>
          <Toggle value="mobile">Mobile</Toggle>
        </ToggleGroup>
      </div>
      <SettingsRow
        {...searchableSetting("thread-card-layout")}
        serverScoped
        settingKeys={["threadCardLayouts"]}
        description={`Arrange the ${surfaceLabel} thread card yourself. Every server you connect to gets the same layout.`}
        resetAction={
          mixed || layout !== null ? (
            <SettingResetButton
              label={`${surfaceLabel} card layout`}
              onClick={() => (surface === "desktop" ? setDesktop(null) : setMobile(null))}
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["threadCardLayouts"]}
            checked={layout !== null}
            onCheckedChange={(checked) => {
              if (surface === "desktop") setDesktop(checked ? DEFAULT_THREAD_CARD_LAYOUT : null);
              else setMobile(checked ? DEFAULT_MOBILE_THREAD_CARD_LAYOUT : null);
            }}
            aria-label={`Custom ${surfaceLabel} card layout`}
          />
        }
      >
        {surface === "desktop" && layouts.desktop !== null ? (
          <div className="flex flex-col gap-3 pt-3">
            <SlotLayoutBuilder
              layout={layouts.desktop}
              elements={DESKTOP_OPTIONS}
              required={REQUIRED_THREAD_CARD_ELEMENTS}
              onChange={setDesktop}
              renderPreview={(layout) => (
                <ThreadCardLayoutPreview layout={layout} surface="desktop" />
              )}
            />
          </div>
        ) : null}
        {surface === "mobile" && layouts.mobile !== null ? (
          <div className="flex flex-col gap-3 pt-3">
            <SlotLayoutBuilder
              layout={layouts.mobile}
              elements={MOBILE_OPTIONS}
              required={REQUIRED_THREAD_CARD_ELEMENTS}
              onChange={setMobile}
              renderPreview={(layout) => (
                <ThreadCardLayoutPreview layout={layout} surface="mobile" />
              )}
            />
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
