import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import {
  describeOutdatedServer,
  serverEnvironment,
  updateOutdatedServer,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { findEnvironmentUpdate } from "./environment-maintenance";

export function OutdatedServerUpdateSection({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const describe = useAtomCommand(describeOutdatedServer, { reportFailure: false });
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const [release, setRelease] = useState<{
    fromVersion: string;
    targetVersion: string | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const busy = checking || state.status === "running";

  async function check() {
    if (busy || controller.current !== null) return;
    const request = new AbortController();
    controller.current = request;
    setChecking(true);
    setError(null);
    const timeout = setTimeout(() => request.abort(), 20_000);
    const result = await settlePromise(async () => {
      const description = await describe(environmentId);
      if (AsyncResult.isFailure(description)) throw squashAtomCommandFailure(description);
      const fromVersion = description.value.serverVersion;
      const targetVersion = await findEnvironmentUpdate(fromVersion, request.signal);
      if (!request.signal.aborted) setRelease({ fromVersion, targetVersion });
    });
    clearTimeout(timeout);
    controller.current = null;
    setChecking(false);
    if (AsyncResult.isFailure(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Nu am putut verifica actualizările.");
    }
  }

  function requestUpdate() {
    const targetVersion = release?.targetVersion;
    if (busy || !release || !targetVersion) return;
    Dialog.alert(
      `Actualizezi ${label}?`,
      `Instalează Mira ${targetVersion}. Mira repornește pe acel calculator și se reconectează. Conversațiile în curs pot fi întrerupte.`,
      [
        { text: "Anulează", style: "cancel" },
        {
          text: "Actualizează",
          onPress: () => {
            setError(null);
            void update({
              environmentId,
              input: { targetVersion },
              fromVersion: release.fromVersion,
            });
          },
        },
      ],
    );
  }

  return (
    <SettingsSection title="Mira">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {release ? `Versiunea ${release.fromVersion}` : "Actualizare necesară"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {state.status === "running"
            ? state.stage === "resuming"
              ? "Se repornește și se reconectează…"
              : state.stage === "installing"
                ? "Se instalează actualizarea…"
                : "Se descarcă actualizarea…"
            : release
              ? release.targetVersion
                ? `Versiunea ${release.targetVersion} este disponibilă.`
                : "Nu există încă o versiune mai nouă."
              : "Aplicația are nevoie de o versiune mai nouă de Mira pe acest calculator."}
        </Text>
        {error || state.status === "failed" ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error ?? (state.status === "failed" ? state.message : null)}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Verifică actualizările"
        disabled={busy}
        loading={checking}
        onPress={() => void check()}
      />
      {release?.targetVersion ? (
        <SettingsActionRow
          icon="arrow.up.circle"
          label={
            state.status === "failed"
              ? "Reîncearcă actualizarea"
              : `Actualizează la ${release.targetVersion}`
          }
          disabled={busy}
          loading={state.status === "running"}
          onPress={requestUpdate}
        />
      ) : null}
    </SettingsSection>
  );
}
