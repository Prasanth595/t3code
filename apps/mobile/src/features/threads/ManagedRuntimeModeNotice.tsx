import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  updateComposerDraftSettings,
  useComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";

/**
 * Shown while a thread's mode is above its environment's managed ceiling, where the server
 * refuses every turn. Switching sets the draft's mode, which the next send applies first.
 */
export function ManagedRuntimeModeNotice(props: {
  readonly threadKey: string;
  readonly threadRuntimeMode: RuntimeMode;
  readonly policy: ManagedPolicySummary | undefined;
}) {
  const draftSettings = useComposerDraftSettings(props.threadKey);
  const runtimeMode = draftSettings.runtimeMode ?? props.threadRuntimeMode;
  const denial = managedRuntimeModeDenial(props.policy, runtimeMode);
  const ceiling = props.policy?.limits?.maxRuntimeMode;
  if (denial === undefined || ceiling === undefined) return null;
  const ceilingLabel =
    RUNTIME_MODE_CHOICES.find((choice) => choice.mode === ceiling)?.label ?? ceiling;
  return (
    <View className="gap-2 px-4 pb-3">
      <AppText textRole="footnote" className="text-foreground-muted">
        {`${denial} Switch this thread's mode to continue.`}
      </AppText>
      <Button
        label={`Switch to ${ceilingLabel}`}
        onPress={() => updateComposerDraftSettings(props.threadKey, { runtimeMode: ceiling })}
      />
    </View>
  );
}
