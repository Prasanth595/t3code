import { BranchNamingMode, type ServerSettingsPatch } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

const MODES = {
  static: { label: "Static prefix", description: "Add your prefix to the generated branch name." },
  semantic: {
    label: "Semantic prefix",
    description: "Let the model choose feat/, fix/, refactor/, or another prefix.",
  },
  custom: {
    label: "Custom instructions",
    description: "Generate the complete name with no added prefix or suffix.",
  },
} satisfies Record<BranchNamingMode, { label: string; description: string }>;

export function BranchNamingSettings(props: {
  mode: BranchNamingMode | null;
  prefix: string | null;
  instructions: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  // Typed text waits here until it saves. Android's Back closes the keyboard
  // without ending editing, so leaving the screen saves it too.
  const drafts = useRef<{ branchNamePrefix?: string; branchNameInstructions?: string }>({});
  const save = (field: "branchNamePrefix" | "branchNameInstructions") => {
    const draft = drafts.current[field];
    delete drafts.current[field];
    if (draft === undefined || props.disabled) return;
    const value = draft.trim();
    const saved = field === "branchNamePrefix" ? props.prefix : props.instructions;
    if (saved === null || value !== saved) props.onChange({ [field]: value });
  };
  const saveDrafts = useEffectEvent(() => {
    save("branchNamePrefix");
    save("branchNameInstructions");
  });
  useEffect(() => () => saveDrafts(), []);
  return (
    <SettingsSection
      title="Worktree branch naming"
      trailing={
        props.mode === null ? <Text className="text-xs text-foreground-muted">Mixed</Text> : null
      }
    >
      {BranchNamingMode.literals.map((mode, index) => (
        <SettingsChoiceRow
          key={mode}
          label={MODES[mode].label}
          description={MODES[mode].description}
          selected={props.mode === mode}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => props.onChange({ branchNamingMode: mode })}
        />
      ))}
      {props.mode === "static" ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            Use t3 or t3/ for t3/add-search. Leave empty for no prefix.
          </Text>
          <AppTextInput
            key={props.prefix}
            accessibilityLabel="Branch prefix"
            onChangeText={(text) => {
              drafts.current.branchNamePrefix = text;
            }}
            defaultValue={props.prefix ?? ""}
            placeholder={props.prefix === null ? "Mixed" : "No prefix"}
            editable={!props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={() => save("branchNamePrefix")}
          />
        </View>
      ) : null}
      {props.mode === "custom" ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            Append instructions to the naming prompt.
          </Text>
          <AppTextInput
            key={props.instructions}
            accessibilityLabel="Branch naming instructions"
            onChangeText={(text) => {
              drafts.current.branchNameInstructions = text;
            }}
            defaultValue={props.instructions ?? ""}
            placeholder={
              props.instructions === null
                ? "Mixed. Enter instructions for all selected targets."
                : "Use julius/ followed by the issue ID and a short description."
            }
            editable={!props.disabled}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={() => save("branchNameInstructions")}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
