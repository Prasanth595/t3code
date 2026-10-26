import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { ModelSelection } from "@t3tools/contracts";
import {
  createModelSelection,
  modelIdentitiesEqual,
  modelSelectionChainsEqual,
  moveModelSelectionChain,
  toggleModelSelectionChain,
} from "@t3tools/shared/model";

import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { SettingsSection } from "./components/SettingsSection";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

export function UsageLimitFallbackChainRows(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly disabled: boolean;
  readonly onChange: (chain: readonly ModelSelection[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const environmentId = props.targets[0]?.environment.environmentId ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const models = useMemo(
    () =>
      buildModelOptions(config, null, undefined, null).filter((option) => !option.isUnavailable),
    [config],
  );
  const first = props.targets[0]?.settings.usageLimitFallbackChain ?? [];
  const mixed = props.targets.some(
    (target) => !modelSelectionChainsEqual(target.settings.usageLimitFallbackChain, first),
  );
  const chain = mixed ? [] : first;

  return (
    <SettingsSection
      title="Continue on the next model"
      footer="When a limit reports a reset time, the thread continues on the next model in this list. An empty list waits for the reset."
    >
      {mixed ? (
        <View className="gap-3 px-4 py-4">
          <Text className="text-base text-foreground">
            Fallback models differ across the selected environments.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={props.disabled}
            onPress={() => props.onChange([])}
            className="self-start active:opacity-70"
          >
            <Text className="text-base text-primary-text">Clear on all</Text>
          </Pressable>
        </View>
      ) : chain.length === 0 ? (
        <View className="px-4 py-4">
          <Text className="text-base text-foreground-muted">
            None. A limit waits for its reset.
          </Text>
        </View>
      ) : (
        chain.map((selection, index) => {
          const option = models.find((candidate) =>
            modelIdentitiesEqual(candidate.selection, selection),
          );
          const label = option
            ? `${option.providerLabel} · ${option.label}`
            : `${selection.instanceId} · ${selection.model}`;
          return (
            <View
              key={`${selection.instanceId}:${selection.model}`}
              className="flex-row items-center gap-3 px-4 py-3"
            >
              <Text className="w-5 text-base text-foreground-muted">{index + 1}</Text>
              <Text className="flex-1 text-base text-foreground">{label}</Text>
              <ChainAction
                label="Up"
                disabled={props.disabled || index === 0}
                onPress={() => props.onChange(moveModelSelectionChain(chain, index, -1))}
              />
              <ChainAction
                label="Down"
                disabled={props.disabled || index === chain.length - 1}
                onPress={() => props.onChange(moveModelSelectionChain(chain, index, 1))}
              />
              <ChainAction
                label="Remove"
                disabled={props.disabled}
                onPress={() => props.onChange(toggleModelSelectionChain(chain, selection))}
              />
            </View>
          );
        })
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: adding }}
        disabled={props.disabled || mixed || models.length === 0}
        onPress={() => setAdding((open) => !open)}
        className="px-4 py-4 active:opacity-70"
      >
        <Text className="text-base text-primary-text">{adding ? "Done" : "Add model"}</Text>
      </Pressable>
      {adding && !mixed
        ? models
            .filter(
              (option) => !chain.some((entry) => modelIdentitiesEqual(entry, option.selection)),
            )
            .map((option) => (
              <Pressable
                key={option.key}
                accessibilityRole="button"
                disabled={props.disabled}
                onPress={() =>
                  props.onChange(
                    toggleModelSelectionChain(
                      chain,
                      createModelSelection(option.selection.instanceId, option.selection.model),
                    ),
                  )
                }
                className="px-4 py-3 active:opacity-70"
              >
                <Text className="text-base text-foreground">
                  {option.providerLabel} · {option.label}
                </Text>
              </Pressable>
            ))
        : null}
    </SettingsSection>
  );
}

function ChainAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="active:opacity-70"
    >
      <Text
        className={props.disabled ? "text-sm text-foreground-muted" : "text-sm text-primary-text"}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
