/**
 * Fork: the editor of one sidebar group, like the group editor of web (SidebarGroupTabs.tsx):
 * its name, icon and rules, or the name, icon and threads of the first tab. Each change saves at
 * once through `editSidebarGroups`.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import {
  buildSidebarGroupProjectFacts,
  buildSidebarGroupRuleOptions,
  DEFAULT_SIDEBAR_GROUP_ID,
  DEFAULT_SIDEBAR_GROUP_NAME,
  deleteSidebarGroup,
  isAnyGroupRule,
  SIDEBAR_GROUP_RULE_FIELDS,
  sidebarGroupRuleFieldLabel,
  toggleSidebarGroupRuleValue,
  updateSidebarDefaultTab,
  updateSidebarGroup,
} from "@t3tools/client-runtime/state/sidebarGroups";
import {
  isKnownSidebarGroupRule,
  type SidebarGroup,
  type SidebarGroupRule,
  type SidebarGroupRuleField,
  type SidebarGroups,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  createMobileSidebarGroup,
  editedSidebarGroupIdAtom,
  editSidebarGroups,
  sidebarGroupsAtom,
} from "../../state/forkSidebarGroups";
import { GROUP_ICON_IDS, GroupIcon } from "../home/forkGroupIcons";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

type ValueField = Exclude<SidebarGroupRuleField, "title">;
const VALUE_FIELDS = SIDEBAR_GROUP_RULE_FIELDS.filter(
  (field): field is ValueField => field !== "title",
);

/** Opens the editor of a group, or of the first tab for `default`. */
export function openSidebarGroupEditor(
  navigation: Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate">,
  groupId: string,
): void {
  appAtomRegistry.set(editedSidebarGroupIdAtom, groupId);
  navigation.navigate("SettingsSheet", {
    screen: "SettingsContent",
    params: { screen: "SettingsSidebarGroup" },
  });
}

export function SettingsSidebarGroupRouteScreen() {
  const insets = useSafeAreaInsets();
  const settings = useAtomValue(sidebarGroupsAtom);
  const groupId = useAtomValue(editedSidebarGroupIdAtom);
  const group = settings?.groups.find((candidate) => candidate.id === groupId);
  const isDefault = groupId === DEFAULT_SIDEBAR_GROUP_ID;
  return (
    <SettingsScreen title={isDefault ? "First tab" : (group?.name ?? "Group")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {settings === null || (!isDefault && group === undefined) ? (
          <AppText className="px-2 text-base text-foreground-muted">
            This group no longer exists, or no connected environment has sidebar group tabs on.
          </AppText>
        ) : isDefault ? (
          <DefaultTabEditor settings={settings} />
        ) : (
          <GroupEditor settings={settings} group={group!} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function DefaultTabEditor(props: { readonly settings: SidebarGroups }) {
  const { defaultTab } = props.settings;
  const setDefaultTab = (
    change: (tab: SidebarGroups["defaultTab"]) => SidebarGroups["defaultTab"],
  ) => editSidebarGroups((current) => updateSidebarDefaultTab(current, change));
  return (
    <>
      <NameField
        name={defaultTab.name ?? ""}
        placeholder={DEFAULT_SIDEBAR_GROUP_NAME}
        onCommit={(name) =>
          setDefaultTab(({ name: _name, ...rest }) =>
            name.length === 0 ? rest : { ...rest, name },
          )
        }
      />
      <LookEditor
        look={defaultTab}
        onChange={(look) => setDefaultTab((tab) => ({ ...tab, ...look }))}
      />
      <SettingsSection title="This tab shows">
        <ListChoiceRow
          label="Threads in no group"
          selected={defaultTab.show !== "all"}
          onPress={() => setDefaultTab((tab) => ({ ...tab, show: "ungrouped" }))}
        />
        <ListChoiceRow
          label="All threads"
          separated
          selected={defaultTab.show === "all"}
          onPress={() => setDefaultTab((tab) => ({ ...tab, show: "all" }))}
        />
      </SettingsSection>
    </>
  );
}

function GroupEditor(props: { readonly settings: SidebarGroups; readonly group: SidebarGroup }) {
  const { settings, group } = props;
  const navigation = useNavigation();
  const update = (change: (group: SidebarGroup) => SidebarGroup) =>
    editSidebarGroups((current) => updateSidebarGroup(current, group.id, change));
  const setRules = (rules: SidebarGroup["rules"]) => update((current) => ({ ...current, rules }));
  const knownRules = group.rules.filter(isKnownSidebarGroupRule);
  const isView = knownRules.some((rule) => rule.field === "group");
  const unknownCount = group.rules.length - knownRules.length;

  // Options come from every live thread, once per change of the threads or the projects.
  const threads = useThreadShells();
  const projects = useProjects();
  const facts = useMemo(() => buildSidebarGroupProjectFacts(projects), [projects]);
  const liveThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt === null),
    [threads],
  );
  const [titleText, setTitleText] = useState("");
  const titleRule = knownRules.find((rule) => rule.field === "title");

  return (
    <>
      <NameField
        name={group.name}
        placeholder="Group name"
        onCommit={(name) => {
          if (name.length > 0) update((current) => ({ ...current, name }));
        }}
      />
      <LookEditor
        look={group}
        onChange={(look) => update((current) => ({ ...current, ...look }))}
      />
      <SettingsSection
        title="Rules"
        footer={
          (knownRules.length === 0
            ? "No rules. The group holds the threads that you move into it."
            : isView
              ? "A view: it shows the threads of other groups that match every rule."
              : "Holds every thread that matches every rule, and the threads that you move into it.") +
          (unknownCount > 0
            ? ` ${unknownCount} rule${unknownCount === 1 ? "" : "s"} from a newer version stay as they are.`
            : "")
        }
      >
        {VALUE_FIELDS.map((field, index) => (
          <RuleFieldEditor
            key={field}
            field={field}
            separated={index > 0}
            rule={knownRules.find((rule) => rule.field === field) ?? null}
            options={() =>
              buildSidebarGroupRuleOptions({
                field,
                groupId: group.id,
                threads: liveThreads,
                projects: facts,
                settings,
              })
            }
            onToggle={(value, checked) =>
              setRules(toggleSidebarGroupRuleValue(group.rules, field, value, checked))
            }
            onSetRule={(next) =>
              setRules(
                next === null
                  ? group.rules.filter(
                      (rule) => !(isKnownSidebarGroupRule(rule) && rule.field === field),
                    )
                  : group.rules.some(
                        (rule) => isKnownSidebarGroupRule(rule) && rule.field === field,
                      )
                    ? group.rules.map((rule) =>
                        isKnownSidebarGroupRule(rule) && rule.field === field ? next : rule,
                      )
                    : [...group.rules, next],
              )
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Title contains">
        {(titleRule?.values ?? []).map((value) => (
          <ListActionRow
            key={value ?? ""}
            label={value ?? ""}
            detail="Remove"
            onPress={() =>
              setRules(toggleSidebarGroupRuleValue(group.rules, "title", value, false))
            }
          />
        ))}
        <View className="px-4 py-3">
          <TextInput
            accessibilityLabel="Add a title rule"
            value={titleText}
            onChangeText={setTitleText}
            returnKeyType="done"
            onSubmitEditing={() => {
              const text = titleText.trim();
              if (text.length === 0) return;
              setRules(toggleSidebarGroupRuleValue(group.rules, "title", text, true));
              setTitleText("");
            }}
            placeholder="Add text, then press Done"
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-8 font-sans text-base text-foreground"
          />
        </View>
      </SettingsSection>
      <SettingsSection>
        <ListActionRow
          label="Delete group"
          tone="danger"
          onPress={() =>
            Dialog.confirm({
              title: `Delete ${group.name}?`,
              message: "Its threads go back to the rules or to the first tab.",
              confirmText: "Delete",
              destructive: true,
              onConfirm: () => {
                editSidebarGroups((current) => deleteSidebarGroup(current, group.id));
                navigation.goBack();
              },
            })
          }
        />
      </SettingsSection>
    </>
  );
}

/** One rule field: closed, it names the picked values; open, it lists every value to check. */
function RuleFieldEditor(props: {
  readonly field: ValueField;
  readonly separated: boolean;
  readonly rule: SidebarGroupRule | null;
  readonly options: () => ReturnType<typeof buildSidebarGroupRuleOptions>;
  readonly onToggle: (value: string | null, checked: boolean) => void;
  readonly onSetRule: (rule: SidebarGroupRule | null) => void;
}) {
  const { field, rule } = props;
  const [open, setOpen] = useState(false);
  // Built only while open, so a closed field costs nothing.
  const options = open ? props.options() : [];
  const anyGroup = rule !== null && isAnyGroupRule(rule);
  const summary =
    rule === null
      ? "Any"
      : anyGroup
        ? "Any group"
        : `${rule.operator === "is" ? "Is" : "Is not"} ${rule.values.length} value${rule.values.length === 1 ? "" : "s"}`;
  return (
    <View className={cn(props.separated && "border-t border-border-subtle")}>
      <ListActionRow
        label={sidebarGroupRuleFieldLabel(field)}
        detail={summary}
        onPress={() => setOpen((current) => !current)}
      />
      {open ? (
        <View className="pb-2">
          {rule !== null && !anyGroup ? (
            <View className="px-4 pb-2">
              <SegmentedControl
                size="compact"
                options={[
                  { value: "is", label: "Is" },
                  { value: "is_not", label: "Is not" },
                ]}
                selected={rule.operator}
                onSelect={(operator) => props.onSetRule({ ...rule, operator })}
              />
            </View>
          ) : null}
          {field === "group" ? (
            <ListToggleRow
              label="Any group (shows every thread)"
              value={anyGroup}
              onValueChange={(checked) =>
                props.onSetRule(checked ? { field: "group", operator: "is_not", values: [] } : null)
              }
            />
          ) : null}
          {options.map((option) => (
            <ListToggleRow
              key={option.value ?? ""}
              label={option.label}
              value={!anyGroup && rule !== null && rule.values.includes(option.value)}
              onValueChange={(checked) => props.onToggle(option.value, checked)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The name field. It saves when the keyboard closes, not at each key. */
function NameField(props: {
  readonly name: string;
  readonly placeholder: string;
  readonly onCommit: (name: string) => void;
}) {
  const [name, setName] = useState(props.name);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed !== props.name) props.onCommit(trimmed);
  };
  return (
    <SettingsSection title="Name">
      <View className="px-4 py-3">
        <TextInput
          accessibilityLabel="Name"
          value={name}
          onChangeText={setName}
          onBlur={commit}
          onSubmitEditing={commit}
          returnKeyType="done"
          placeholder={props.placeholder}
          placeholderTextColorClassName="accent-foreground-muted"
          className="min-h-8 font-sans text-base text-foreground"
        />
      </View>
    </SettingsSection>
  );
}

type TabLook = { readonly icon?: string; readonly showName?: boolean };

/** The icon and the name of a tab. `none` hides the icon; without a choice the tab shows a dot. */
function LookEditor(props: {
  readonly look: { readonly icon?: string | undefined; readonly showName?: boolean | undefined };
  readonly onChange: (look: TabLook) => void;
}) {
  const current = props.look.icon ?? "dot";
  const { color: selectedColor } = useResolveClassNames("text-foreground");
  const { color: mutedColor } = useResolveClassNames("text-foreground-muted");
  return (
    <SettingsSection title="Tab">
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1 px-3 py-3">
        {[...GROUP_ICON_IDS, "none"].map((id) => (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={id === "none" ? "No icon" : id}
            accessibilityState={{ checked: current === id }}
            onPress={() => props.onChange({ icon: id })}
            className={cn(
              "size-10 items-center justify-center rounded-lg active:opacity-70",
              current === id && "bg-subtle",
            )}
          >
            {id === "none" ? (
              <SymbolView name="xmark" size={18} tintColorClassName="accent-foreground-muted" />
            ) : (
              <GroupIcon icon={id} size={20} color={current === id ? selectedColor : mutedColor} />
            )}
          </Pressable>
        ))}
      </View>
      <ListToggleRow
        label="Show the name on the tab"
        value={props.look.showName !== false}
        onValueChange={(showName) => props.onChange({ showName })}
      />
    </SettingsSection>
  );
}

/** The groups in the Fork settings page: each one opens its editor, and the last row makes one. */
export function SidebarGroupSettingsSection() {
  const settings = useAtomValue(sidebarGroupsAtom);
  const navigation = useNavigation();
  if (settings === null) return null;
  return (
    <SettingsSection
      title="Sidebar groups"
      footer="Long-press a tab or a thread on the thread list for the same changes."
    >
      <ListActionRow
        label={settings.defaultTab.name ?? DEFAULT_SIDEBAR_GROUP_NAME}
        detail="First tab"
        onPress={() => openSidebarGroupEditor(navigation, DEFAULT_SIDEBAR_GROUP_ID)}
      />
      {settings.groups.map((group) => (
        <ListActionRow
          key={group.id}
          label={group.name}
          onPress={() => openSidebarGroupEditor(navigation, group.id)}
        />
      ))}
      <ListActionRow
        icon="plus"
        label="New group"
        onPress={() => openSidebarGroupEditor(navigation, createMobileSidebarGroup())}
      />
    </SettingsSection>
  );
}
