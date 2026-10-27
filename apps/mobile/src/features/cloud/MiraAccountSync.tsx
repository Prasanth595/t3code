import { useAuth } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { environmentsToAutoConnect } from "@t3tools/client-runtime/relay";
import * as SecureStore from "expo-secure-store";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { fetchMiraAccount, miraAccess, miraChatHistory, miraChatRemote } from "../chat/miraChat";
import { useWorkspaceEnvironments } from "../../state/workspace";

// SecureStore keys allow only letters, digits, ".", "-", and "_".
const autoAddedKey = (accountId: string) =>
  `mira.autoAddedComputers.${accountId.replace(/[^\w.-]/g, "_")}`;

async function readAutoAdded(accountId: string): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(
      (await SecureStore.getItemAsync(autoAddedKey(accountId))) ?? "[]",
    );
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Adds every computer on the signed-in account; one the user removes later stays removed. */
export function MiraAccountSync() {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const accountId = isSignedIn && userId ? userId : null;
  const environments = useWorkspaceEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const autoAdded = useRef<Set<string>>(new Set());

  // The plan decides chat limits and agentic access; chats follow the account across devices.
  useEffect(() => {
    // Before Clerk restores the session everyone looks signed out, which would drop the account's chats.
    if (!isLoaded) return;
    if (accountId === null) {
      miraAccess.set({ signedIn: false, account: null, openSignIn: null });
      void miraChatHistory.setRemote(null);
      return;
    }
    let cancelled = false;
    const refresh = () =>
      fetchMiraAccount().then(
        (account) => {
          if (!cancelled) miraAccess.set({ signedIn: true, account, openSignIn: null });
        },
        (cause: unknown) => console.warn("[mira] Could not read the account", cause),
      );
    miraAccess.set({ signedIn: true, account: null, openSignIn: null });
    void refresh();
    void miraChatHistory.setRemote(miraChatRemote(accountId));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void refresh();
      void miraChatHistory.sync();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [isLoaded, accountId]);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    void readAutoAdded(accountId).then((ids) => {
      if (cancelled) return;
      autoAdded.current = new Set(ids);
      setLoadedFor(accountId);
    });
    void refreshDiscovery();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshDiscovery();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [accountId, refreshDiscovery]);

  const addAccountComputers = useEffectEvent(() => {
    if (accountId === null || loadedFor !== accountId) return;
    const pending = environmentsToAutoConnect({
      discovered: discovery.environments,
      savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
      localEnvironmentId: null,
      previouslyAdded: autoAdded.current,
    });
    if (pending.length === 0) return;
    for (const environment of pending) autoAdded.current.add(environment.environmentId);
    void SecureStore.setItemAsync(autoAddedKey(accountId), JSON.stringify([...autoAdded.current]));
    for (const environment of pending) {
      void registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      );
    }
  });

  useEffect(() => {
    addAccountComputers();
  });

  return null;
}
