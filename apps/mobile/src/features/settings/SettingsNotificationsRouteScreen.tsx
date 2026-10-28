import * as Dialog from "../../components/ui/Dialog";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

export function SettingsNotificationsRouteScreen() {
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title="Notificări">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            Notificările necesită contul Mira în această versiune a aplicației.
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? "Instalează o versiune mai nouă a aplicației ca să activezi notificările"
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const liveActivityWriteInFlight = useRef(false);
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;

  const connections = Object.values(savedConnectionsById);
  const environmentCount = connections.length;

  const refreshNotifications = async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  };

  useEffect(() => {
    void refreshNotifications();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshNotifications();
    });
    return () => subscription.remove();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Notificări indisponibile",
          error instanceof Error
            ? error.message
            : "Nu am putut cere permisiunea pentru notificări.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Dialog.alert(
          "Notificări activate",
          "Notificările agentului sunt activate pe acest dispozitiv.",
        );
      } else {
        Dialog.alert(
          "Activarea notificărilor nu s-a putut finaliza",
          "Accesul la notificări a fost acordat, dar dispozitivul nu a putut fi înregistrat în T3 Connect. Notificările vor porni după ce înregistrarea reușește.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Dialog.alert(
        "Notificări indisponibile",
        "Notificările agentului nu sunt disponibile pe această platformă.",
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Dialog.alert("Notificări dezactivate", "Notificările nu au fost activate.");
      return;
    }
    Dialog.alert(
      "Notificări dezactivate",
      "Notificările au fost refuzate pentru această aplicație. Deschide Setările ca să le activezi.",
      [
        { text: "Anulează", style: "cancel" },
        { text: "Deschide Setările", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const promptSignIn = () => {
    Dialog.alert(
      "Autentifică-te în T3 Connect",
      "Actualizările Live Activity necesită T3 Connect ca relay-ul să trimită actualizări pe acest dispozitiv.",
      [
        { text: "Anulează", style: "cancel" },
        {
          text: "Continuă",
          onPress: () => navigation.navigate("SettingsAuth"),
        },
      ],
    );
  };

  const linkEnvironments = async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Dialog.alert(
          "Activitatea în curs nu e disponibilă",
          error instanceof Error ? error.message : "Nu am putut activa notificările agentului.",
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Dialog.alert(
          "E nevoie de permisiunea pentru notificări",
          "Activează notificările din Setările sistemului ca să vezi activitatea agentului.",
          [
            { text: "Anulează", style: "cancel" },
            { text: "Deschide Setările", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Dialog.alert(
        Platform.OS === "android"
          ? "Activitatea în curs nu e disponibilă"
          : "Live Activities indisponibile",
        error instanceof Error
          ? error.message
          : "Nu am putut activa actualizările de activitate ale agentului.",
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          canConfigureEnvironment: (environmentId) =>
            readEnvironmentScope(environmentId, AuthRelayWriteScope),
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Dialog.alert(
          Platform.OS === "android"
            ? "Activitatea în curs nu e disponibilă"
            : "Live Activities indisponibile",
          error instanceof Error
            ? error.message
            : "Nu am putut activa actualizările de activitate ale agentului.",
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // Environment linking can precede device registration; only registered devices can receive Live Activities.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Dialog.alert(
        Platform.OS === "android" ? "Activitate în curs activată" : "Live Activities activate",
        environmentCount > 0
          ? "Actualizările de activitate sunt activate pentru mediile pe care le poate configura această conexiune."
          : "Actualizările de activitate sunt activate. Adaugă un mediu ca să începi să le primești.",
      );
    } else {
      Dialog.alert(
        "Activarea actualizărilor nu s-a putut finaliza",
        "Dispozitivul nu a putut fi înregistrat în T3 Connect, așa că actualizările nu apar încă. Vor porni după ce înregistrarea reușește.",
      );
    }
  };

  const handleDeviceNotificationsChange = (enabled: boolean) => {
    if (enabled) {
      if (!isSignedIn) {
        promptSignIn();
        return;
      }
      void requestNotifications();
      return;
    }

    Dialog.alert(
      "Dezactivează notificările",
      "Deschide Setările sistemului ca să dezactivezi notificările pentru Mira.",
      [
        { text: "Anulează", style: "cancel" },
        { text: "Deschide Setările", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  async function disableLiveActivities() {
    let token: string | null = null;
    if (isSignedIn) {
      const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
      if (tokenResult._tag === "Failure") {
        setLiveActivityStatus("enabled");
        reportAtomCommandResult(tokenResult, {
          label: "live activity disable token lookup",
        });
        return;
      }
      token = tokenResult.value;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          canConfigureEnvironment: (environmentId) =>
            readEnvironmentScope(environmentId, AuthRelayWriteScope),
          enabled: false,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: token,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
      reportAtomCommandResult(updateResult, {
        label: "live activity disable",
      });
      return;
    }
    savePreferences({ liveActivitiesEnabled: false });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("disabled");
  }

  // Both writers settle their own failures, so awaiting them never throws.
  const handleLiveActivitiesChange = async (enabled: boolean) => {
    if (liveActivityWriteInFlight.current) return;
    if (!enabled) {
      liveActivityWriteInFlight.current = true;
      setLiveActivityStatus("linking");
      await disableLiveActivities();
      liveActivityWriteInFlight.current = false;
      return;
    }

    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    liveActivityWriteInFlight.current = true;
    await linkEnvironments();
    liveActivityWriteInFlight.current = false;
  };

  return (
    <SettingsScreen title="Notificări">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Activitatea agentului">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Notificări pe dispozitiv"
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && deviceRegistered
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? "Actualizări live ale agentului"
                  : "Activitatea agentului în curs"
                : "Actualizări Live Activity"
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={(enabled) => void handleLiveActivitiesChange(enabled)}
          />
          {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
            <SettingsRow
              icon="bolt.circle"
              label="Oprește preferința Live Activity"
              onPress={() => void handleLiveActivitiesChange(false)}
            />
          ) : null}
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label="Setări actualizări live"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Dialog.alert(
                    "Setările nu au putut fi deschise",
                    "Deschide Setările Android, alege Mira, apoi activează Actualizările live din Notificări.",
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
