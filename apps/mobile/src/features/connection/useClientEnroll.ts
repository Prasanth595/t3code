/**
 * Fork: uses a portal invite (MM-913) from Add environment. The invite gives
 * this app its own Cloudflare Access service token; the app saves it for the
 * portal and every machine, then pairs with each machine. A machine that fails
 * does not stop the others.
 */
import { requestHeaderOrigin } from "@t3tools/client-runtime/connection";
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
import {
  setPendingConnectionError,
  useRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { useSaveCloudflareAccessToken } from "./CloudflareAccessFields";
import { buildPairingUrl } from "./pairing";

interface ClientEnrollResult {
  readonly name: string;
  readonly paired: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  readonly undoFailures: ReadonlyArray<string>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useEnrollClient() {
  const saveToken = useSaveCloudflareAccessToken();
  const { onConnectPress } = useRemoteConnections();
  return useCallback(
    async (invite: ClientInvite): Promise<ClientEnrollResult> => {
      const enrolled = await redeemClientInvite(invite);
      const portalOrigin = requestHeaderOrigin(enrolled.machinesUrl);
      if (portalOrigin === null) throw new Error("The portal sent an invalid machine list URL.");
      // The portal origin keeps the token for the machine list (MM-914).
      const origins = [portalOrigin, ...enrolled.machines.map((machine) => machine.origin)];
      const undos = new Map<string, () => Promise<string | null>>();
      const undoFailures: string[] = [];
      // A token saved for an origin that ends with no environment stays unreachable, so undo it.
      const undo = async (origin: string) => {
        const error = await undos.get(origin)?.();
        undos.delete(origin);
        if (error) undoFailures.push(`The token for ${origin} could not be removed. ${error}`);
      };
      for (const origin of new Set(origins.map(requestHeaderOrigin))) {
        if (origin === null) continue;
        const saved = await saveToken(origin, enrolled.serviceToken);
        if ("error" in saved) {
          for (const done of undos.keys()) await undo(done);
          throw new Error([saved.error, ...undoFailures].join("\n"));
        }
        undos.set(origin, saved.undo);
      }

      const paired: string[] = [];
      const failed: Array<{ name: string; reason: string }> = [];
      for (const machine of enrolled.machines) {
        try {
          const credential = await issueMachinePairingCredential(machine.origin);
          const result = await onConnectPress(buildPairingUrl(machine.origin, credential));
          if (AsyncResult.isSuccess(result)) {
            paired.push(machine.name);
            continue;
          }
          failed.push({ name: machine.name, reason: message(Cause.squash(result.cause)) });
        } catch (cause) {
          failed.push({ name: machine.name, reason: message(cause) });
        }
        const origin = requestHeaderOrigin(machine.origin);
        // Two machines can share an origin; keep the token while one of them paired.
        const shared = enrolled.machines.some(
          (other) => paired.includes(other.name) && requestHeaderOrigin(other.origin) === origin,
        );
        if (origin !== null && origin !== portalOrigin && !shared) await undo(origin);
      }
      if (paired.length === 0) for (const origin of undos.keys()) await undo(origin);
      return { name: enrolled.name, paired, failed, undoFailures };
    },
    [onConnectPress, saveToken],
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
      try {
        const result = await enrollClient(invite);
        const failures = [
          ...result.failed.map((entry) => `${entry.name}: ${entry.reason}`),
          ...result.undoFailures,
        ];
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
            ? `"${result.name}" has no machines yet. Give it access in the portal.`
            : [`Paired: ${result.paired.join(", ") || "none"}.`, ...failures].join("\n"),
        );
      } catch (cause) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPendingConnectionError(message(cause));
      } finally {
        setSubmitting(false);
      }
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
