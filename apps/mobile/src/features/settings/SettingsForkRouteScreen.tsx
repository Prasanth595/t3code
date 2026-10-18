import {
  AuthSettingsWriteScope,
  type MobileNewThreadProject,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

const NEW_THREAD_CHOICES: ReadonlyArray<{
  readonly mode: MobileNewThreadProject;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "picker", label: "Choose a project", description: "Show the project list first." },
  {
    mode: "last",
    label: "Last project",
    description: "Open a draft in the project of the last new thread on this phone.",
  },
  { mode: "none", label: "No project", description: "Open a draft without a project." },
];

/**
 * Fork: the fork settings that apply to the mobile app, like the Fork page of web settings. Each
 * one is a server setting, so the machine map can sync it. A change here writes it to each
 * selected environment.
 */
export function SettingsForkRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const targets = resolveMobileSettingsTargets(selectedTargets, null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "fork settings update",
    reportFailure: true,
  });
  const disabled =
    targets.length === 0 ||
    pendingWrites > 0 ||
    !targets.every((target) => writableEnvironments.has(target.environment.environmentId));

  const write = (patch: ServerSettingsPatch) => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(targets, false, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingWrites((count) => count - 1);
    });
  };
  const newThreadProject = uniformMobileSetting(targets, "mobileNewThreadProject");

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Fork" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Use the filter above to select a connected environment.
            </Text>
          ) : (
            <>
              <SettingsSection title="Web app and look">
                <SettingsSwitchRow
                  icon="paintbrush"
                  label="Published themes"
                  subtitle="Offer the themes of your servers in Appearance, with their fonts, shape and canvas pattern, and take the default theme of the server."
                  value={uniformMobileSetting(targets, "mobilePublishedThemes")}
                  disabled={disabled}
                  onValueChange={(value) => write({ mobilePublishedThemes: value })}
                />
                <SettingsSwitchRow
                  icon="camera"
                  label="Camera in the composer"
                  subtitle="The plus button of the composer offers Take Photo."
                  value={uniformMobileSetting(targets, "mobileComposerCamera")}
                  disabled={disabled}
                  onValueChange={(value) => write({ mobileComposerCamera: value })}
                />
                <SettingsSwitchRow
                  icon="link"
                  label="Thread link chips"
                  subtitle="Thread links in chat look like an attached thread and open the thread here."
                  value={uniformMobileSetting(targets, "threadLinkChips")}
                  disabled={disabled}
                  onValueChange={(value) => write({ threadLinkChips: value })}
                />
              </SettingsSection>
              <SettingsSection title="New thread opens">
                {NEW_THREAD_CHOICES.map((choice, index) => (
                  <SettingsChoiceRow
                    key={choice.mode}
                    label={choice.label}
                    description={choice.description}
                    selected={newThreadProject === choice.mode}
                    separated={index > 0}
                    disabled={disabled}
                    onPress={() => write({ mobileNewThreadProject: choice.mode })}
                  />
                ))}
              </SettingsSection>
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}
