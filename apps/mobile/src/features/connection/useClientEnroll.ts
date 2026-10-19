/**
 * Fork: uses a portal invite (MM-913) from Add environment. The invite gives
 * this app its own Cloudflare Access service token; the app saves it for the
 * portal and every machine, then pairs with each machine. A machine that fails
 * does not stop the others, and the app keeps the token, so the app token repair
 * pairs it later.
 */
import { requestHeaderOrigin } from "@t3tools/client-runtime/connection";
import { useAtomSet } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import {
  type ClientInvite,
  issueMachinePairingCredential,
  parseClientInvite,
  redeemClientInvite,
} from "../../connection/clientEnroll";
import { type ClientEnrollResult, enrollWithInvite } from "../../connection/clientEnrollSteps";
import { requestAppTokenSync } from "../../connection/forkAppTokenRepair";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import {
  setPendingConnectionError,
  useRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { useSaveCloudflareAccessToken } from "./CloudflareAccessFields";
import { buildPairingUrl } from "./pairing";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useEnrollClient() {
  const saveToken = useSaveCloudflareAccessToken();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { onConnectPress } = useRemoteConnections();
  return useCallback(
    (invite: ClientInvite): Promise<ClientEnrollResult> =>
      enrollWithInvite(invite, {
        redeem: redeemClientInvite,
        origin: requestHeaderOrigin,
        saveToken,
        saveClient: (client) => savePreferences({ appTokenClient: client }),
        pair: async (machine) => {
          const credential = await issueMachinePairingCredential(machine.origin);
          const result = await onConnectPress(buildPairingUrl(machine.origin, credential));
          if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
        },
      }),
    [onConnectPress, savePreferences, saveToken],
  );
}

/**
 * Returns `enrollInvite(text)`. It starts the enroll and returns true when
 * `text` is a portal invite, and returns false for any other text.
 */
export function useClientEnroll(setSubmitting: (submitting: boolean) => void) {
  const enrollClient = useEnrollClient();
  const navigation = useNavigation();
  const run = useCallback(
    async (invite: ClientInvite) => {
      setSubmitting(true);
      setPendingConnectionError(null);
      // No `finally`: the React Compiler cannot compile a try/finally.
      let result: Awaited<ReturnType<typeof enrollClient>>;
      try {
        result = await enrollClient(invite);
      } catch (cause) {
        setSubmitting(false);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPendingConnectionError(message(cause));
        return;
      }
      setSubmitting(false);
      // The saved app token stays; the repair pairs the machines that failed or come later.
      requestAppTokenSync();
      const failures = result.failed.map((entry) => `${entry.name}: ${entry.reason}`);
      if (result.paired.length > 0 && failures.length === 0) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Same as Add environment: return to what opened the sheet, so Home never nests in a sheet.
        if (navigation.canGoBack()) navigation.goBack();
        else navigation.dispatch(StackActions.replace("Home"));
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPendingConnectionError(
        result.paired.length === 0 && failures.length === 0
          ? `"${result.name}" has no machines yet. Give it access in the portal; this phone then adds them by itself.`
          : [
              `Paired: ${result.paired.join(", ") || "none"}.`,
              ...failures,
              "This phone keeps the app token and tries the other machines again by itself.",
            ].join("\n"),
      );
    },
    [enrollClient, navigation, setSubmitting],
  );
  return useCallback(
    (text: string): boolean => {
      const invite = parseClientInvite(text);
      if (invite === null) return false;
      void run(invite);
      return true;
    },
    [run],
  );
}
