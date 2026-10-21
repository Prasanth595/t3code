import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";

/** Base branch for new worktrees. `null` means the selected targets differ. */
export function WorktreeBaseBranchField(props: {
  value: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  // Typed text waits here until it saves. Android's Back closes the keyboard
  // without ending editing, so leaving the screen saves it too.
  const draft = useRef<{ text: string; over: string | null } | null>(null);
  // A newer saved value remounts the input, so a draft typed over an older
  // one is no longer on screen and is dropped.
  const save = () => {
    const current = draft.current;
    draft.current = null;
    if (current === null || current.over !== props.value) return;
    const value = current.text.trim();
    if (props.value === null || value !== props.value) {
      props.onChange({ newWorktreesBaseBranch: value });
    }
  };
  const saveOnLeave = useEffectEvent(save);
  useEffect(() => () => saveOnLeave(), []);
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        New worktrees start from this branch. Leave empty to use the default branch.
      </Text>
      <AppTextInput
        key={props.value}
        accessibilityLabel="Worktree base branch"
        onChangeText={(text) => {
          draft.current = { text, over: props.value };
        }}
        defaultValue={props.value ?? ""}
        placeholder={props.value === null ? "Mixed" : "Default branch"}
        editable={!props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onEndEditing={save}
      />
    </View>
  );
}
