import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import Constants from "expo-constants";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import {
  type ApkRelease,
  checkForApkUpdate,
  isApkUpdateSupported,
  readMiraBuildInfo,
} from "../updates/apk-updates";
import { installApkRelease } from "../updates/MiraApkUpdatePrompt";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="Despre Mira">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Match app.config.ts's production fallback to avoid mislabeling builds as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const releaseTag = readMiraBuildInfo()?.releaseTag.replace("mira-preview-", "");
  const variantSuffix = releaseTag ?? variantLabel;
  const versionLabel = variantSuffix ? `${version} · ${variantSuffix}` : version;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  async function checkForUpdate() {
    // disabled updates next render; the ref blocks same-frame double taps.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    // Failures arrive through onFailure; the settled result only matters for unlocking.
    await settlePromise(() =>
      runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Dialog.alert("Actualizarea a eșuat", message),
        onStateChange: setUpdateState,
      }),
    );
    updateInFlight.current = false;
  }

  function handleVersionPress() {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }

  const statusLabel =
    updateState === "checking"
      ? "Se verifică…"
      : updateState === "downloading"
        ? "Se descarcă…"
        : updateState === "ready"
          ? "Actualizare pregătită"
          : updateState === "restarting"
            ? "Se repornește…"
            : updateState === "current"
              ? "La zi"
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Versiune</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="Aplicație">
      <SettingsRow icon="internaldrive" label="Stocare locală" target="SettingsClientStorage" />
      <SettingsRow icon="stethoscope" label="Diagnosticare" target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label="Licențe open source"
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label="Informații legale" fullScreenTarget="SettingsLegal" />
      {isApkUpdateSupported() ? <ApkUpdateRow /> : null}
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Versiunea ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

type ApkUpdateState =
  | { readonly kind: "idle" | "checking" | "current" | "installing" }
  | { readonly kind: "available"; readonly release: ApkRelease };

function ApkUpdateRow() {
  const [state, setState] = useState<ApkUpdateState>({ kind: "idle" });

  async function press() {
    if (state.kind === "checking" || state.kind === "installing") return;
    if (state.kind === "available") {
      setState({ kind: "installing" });
      await installApkRelease(state.release);
      setState({ kind: "available", release: state.release });
      return;
    }
    setState({ kind: "checking" });
    try {
      const release = await checkForApkUpdate();
      setState(release ? { kind: "available", release } : { kind: "current" });
    } catch (cause) {
      setState({ kind: "idle" });
      Dialog.alert(
        "Nu am putut verifica actualizările",
        cause instanceof Error ? cause.message : "Încearcă din nou.",
      );
    }
  }

  const detail =
    state.kind === "checking"
      ? "Se verifică…"
      : state.kind === "current"
        ? "Ai cea mai nouă versiune"
        : state.kind === "installing"
          ? "Se descarcă…"
          : state.kind === "available"
            ? `Versiune nouă: ${state.release.name}. Atinge ca s-o instalezi.`
            : "Atinge ca să verifici";

  return (
    <Pressable accessibilityRole="button" onPress={() => void press()}>
      <View className="flex-row items-center gap-4 p-4">
        <SymbolView
          name="arrow.down.circle"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="flex-1">
          <Text className="text-lg text-foreground">Actualizează aplicația</Text>
          <Text className="text-xs text-foreground-muted">{detail}</Text>
        </View>
      </View>
    </Pressable>
  );
}
