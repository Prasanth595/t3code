import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { environmentsToAutoConnect } from "@t3tools/client-runtime/relay";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isElectron } from "../env";
import {
  useEnvironmentIds,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../state/environments";
import { relayEnvironmentDiscovery } from "../state/relay";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  hasMiraEnvironment,
  issueMiraModelKey,
  MIRA_PI_INSTANCE_ID,
  miraPiInstance,
} from "./miraAccount";
import {
  isComputerSharingOff,
  readAutoAddedComputers,
  rememberAutoAddedComputer,
} from "./miraSharing";
import { miraAccess, miraChatHistory, miraChatRemote } from "./miraChat";
import { fetchMiraAccount } from "./miraAccount";
import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { useCloudLinkController } from "./useCloudLinkController";

const DISCOVERY_REFRESH_MS = 60_000;

/**
 * Keeps a signed-in account's computers in sync with no clicks: this desktop shares itself on
 * the account, runs Pi on the account's model, and adds the account's other computers.
 */
export function MiraAccountSync() {
  const { isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const accountId = isSignedIn && userId ? userId : null;
  const clerk = useClerk();
  const openSignIn = useEffectEvent(() =>
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron)),
  );

  // The plan decides chat limits and agentic access everywhere in the app.
  useEffect(() => {
    const signIn = () => openSignIn();
    if (accountId === null) {
      miraAccess.set({ signedIn: false, account: null, openSignIn: signIn });
      void miraChatHistory.setRemote(null);
      return;
    }
    let cancelled = false;
    const refresh = () =>
      fetchMiraAccount().then(
        (account) => {
          if (!cancelled) miraAccess.set({ signedIn: true, account, openSignIn: signIn });
        },
        (cause: unknown) => console.warn("[mira] Could not read the account", cause),
      );
    miraAccess.set({ signedIn: true, account: null, openSignIn: signIn });
    void refresh();
    void miraChatHistory.setRemote(miraChatRemote(accountId));
    const onFocus = () => {
      void refresh();
      void miraChatHistory.sync();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [accountId]);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(primaryEnvironmentId));
  const environmentIds = useEnvironmentIds();
  const discovery = useRelayEnvironmentDiscovery();
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  const cloudLink = useCloudLinkController();
  const sharingAttemptedFor = useRef<string | null>(null);
  const modelAttemptedFor = useRef<string | null>(null);

  useEffect(() => {
    if (accountId === null) return;
    void refreshDiscovery();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshDiscovery();
    };
    const interval = setInterval(refreshWhenVisible, DISCOVERY_REFRESH_MS);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [accountId, refreshDiscovery]);

  const shareThisComputer = useEffectEvent((account: string) => {
    if (!isElectron || sharingAttemptedFor.current === account) return;
    if (cloudLink.linkState.data === null || cloudLink.linkState.target === null) return;
    sharingAttemptedFor.current = account;
    if (cloudLink.linked || isComputerSharingOff(account)) return;
    void cloudLink.reconcileCloudState({ managedTunnel: true, publish: true });
  });

  const connectModel = useEffectEvent((account: string) => {
    if (primaryEnvironmentId === null || serverConfig === null) return;
    if (modelAttemptedFor.current === account || hasMiraEnvironment(serverConfig.settings)) return;
    modelAttemptedFor.current = account;
    void (async () => {
      const key = await issueMiraModelKey();
      const result = await mutateProviderInstance({
        environmentId: primaryEnvironmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId: MIRA_PI_INSTANCE_ID,
            instance: miraPiInstance(serverConfig.settings, key),
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    })().catch((cause: unknown) => {
      // Retried on the next sign-in or restart; onboarding and Settings surface the error.
      console.warn("[mira] Could not connect the Mira model", cause);
      modelAttemptedFor.current = null;
    });
  });

  const addAccountComputers = useEffectEvent((account: string) => {
    const pending = environmentsToAutoConnect({
      discovered: discovery.environments,
      savedEnvironmentIds: new Set(environmentIds),
      localEnvironmentId: primaryEnvironmentId,
      previouslyAdded: readAutoAddedComputers(account),
    });
    for (const environment of pending) {
      rememberAutoAddedComputer(account, environment.environmentId);
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
    if (accountId === null) return;
    shareThisComputer(accountId);
    connectModel(accountId);
    addAccountComputers(accountId);
  });

  return null;
}
