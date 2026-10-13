import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { environmentHostedMcpUrl, grokBotMcpSetup } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { environmentCatalog } from "../../connection/catalog";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { appAtomRegistry } from "../../state/atom-registry";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { EnvironmentRoutesSection } from "./EnvironmentRoutesSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  findEnvironmentUpdate,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";

export function SettingsEnvironmentDetailRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>) {
  // Key local request state to the host even when navigation reuses this screen.
  return (
    <EnvironmentDetail
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function EnvironmentDetail({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const connections = useRemoteConnections();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const relayDiscovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const relay = relayDiscovery.environments.get(environmentId);
  const grokMcpUrl = environmentHostedMcpUrl({
    entry: catalog.entries.get(environmentId),
    relayHttpBaseUrl: relay?.environment.endpoint.httpBaseUrl,
  });
  const grokSetup = grokMcpUrl === null ? null : grokBotMcpSetup(grokMcpUrl);
  const environment = connections.connectedEnvironments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const updateServer = useAtomCommand(serverEnvironment.updateServer);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [release, setRelease] = useState<{
    fromVersion: string;
    targetVersion: string | null;
  } | null>(null);
  const checkController = useRef<AbortController | null>(null);
  useEffect(() => () => checkController.current?.abort(), []);

  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const allowed =
    !AsyncResult.isFailure(sessionResult) && canMaintainEnvironment(session, connected);
  const running = updateState.status === "running";
  const providerBusy =
    config?.providers.some(
      (provider) =>
        provider.updateState?.status === "running" || provider.updateState?.status === "queued",
    ) ?? false;
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const busy = !connected || pending !== null || running || providerBusy;
  const disabled = !allowed || busy;
  const version = config?.environment.serverVersion;
  const checkedRelease = release?.fromVersion === version ? release : null;
  const capabilities = config?.environment.capabilities;

  async function run(label: string, action: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The action could not be completed. Try again.",
      );
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  function requestServerUpdate() {
    const targetVersion = checkedRelease?.targetVersion;
    if (disabled || !targetVersion || !capabilities || !supportsEnvironmentUpdate(capabilities))
      return;
    Alert.alert(
      `Update ${environment?.environmentLabel ?? "environment"}?`,
      `Install T3 Code ${targetVersion}. ${capabilities.serverSelfUpdate === "desktop-managed" ? "The desktop app will close and relaunch." : "The server will restart and reconnect."} Running threads may be interrupted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: () =>
            void run("server", async () => {
              if (
                AsyncResult.isFailure(
                  appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
                ) ||
                !canMaintainEnvironment(
                  appAtomRegistry.get(environmentSession.sessionStateValueAtom(environmentId)),
                  connected,
                )
              )
                return;
              const result = await updateServer({
                environmentId,
                input: {
                  targetVersion,
                  ...(capabilities.serverUpdateThreadContinuation &&
                  config?.settings.continueThreadsAfterServerUpdate
                    ? { continueRunningThreads: true }
                    : {}),
                },
              });
              if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              setRelease(null);
              setNotice(`Updated to ${result.value.targetVersion}.`);
            }),
        },
      ],
    );
  }

  function requestProviderUpdate(provider: ServerProvider) {
    if (
      busy ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      !canUpdateEnvironmentProvider(provider)
    )
      return;
    void run(provider.instanceId, async () => {
      const result = await updateProvider({
        environmentId,
        input: {
          provider: provider.driver,
          instanceId: provider.instanceId,
        },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
    });
  }

  async function copyGrokBotSetup(value: string, label: string) {
    setError(null);
    setNotice(null);
    if (await tryCopyTextWithHaptic(value, { target: label })) {
      setNotice(`${label} copied.`);
    } else {
      setError(`Could not copy ${label.toLowerCase()}.`);
    }
  }

  return (
    <SettingsScreen title={environment?.environmentLabel ?? "Environment"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!environment ? (
          <Text className="text-base text-foreground-muted">
            This environment is no longer saved on this device.
          </Text>
        ) : (
          <>
            <SettingsSection title="Connection">
              <ConnectionEnvironmentRow
                environment={environment}
                expanded={connectionExpanded}
                onToggle={() => setConnectionExpanded((value) => !value)}
                onReconnect={connections.onReconnectEnvironment}
                onRemove={connections.onRemoveEnvironmentPress}
                onSetEnabled={connections.onSetEnvironmentEnabled}
                onUpdate={connections.onUpdateEnvironment}
              />
            </SettingsSection>
            <EnvironmentRoutesSection
              environmentId={environmentId}
              connected={connected}
              onAddRoute={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: {
                    screen: "SettingsEnvironmentNew",
                    params: { routeFor: environmentId },
                  },
                })
              }
            />
            <SettingsSection
              title="Grok Bot"
              footer={
                grokSetup
                  ? "Start with Read only to verify access. Choose Supervised or above to let the bot create and message threads. Revoke access in T3 Code’s Connections settings."
                  : undefined
              }
            >
              <View className="gap-2 p-4">
                <Text className="text-sm text-foreground-muted">
                  Connect Grok Bot to this environment’s existing projects and threads with a custom
                  MCP plugin.
                </Text>
                {grokMcpUrl ? (
                  <>
                    <Text selectable className="text-sm text-foreground">
                      {grokMcpUrl}
                    </Text>
                    <Text className="text-sm text-foreground-muted">
                      Paste the setup prompt into Grok Bot, or add a custom plugin with the MCP
                      configuration. Use OAuth sign-in and leave headers and optional client
                      credentials empty. T3’s approval page may name the client “Cursor”.
                    </Text>
                    {relay?.availability === "offline" ? (
                      <Text className="text-sm text-foreground-muted">
                        T3 Connect reports this environment offline. Turn on remote access on its
                        host before connecting Grok Bot.
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text className="text-sm text-foreground-muted">
                    Enable T3 Connect on this environment’s host, or add a public HTTPS route. Grok
                    Bot runs in the cloud and cannot use local or Tailscale addresses.
                  </Text>
                )}
              </View>
              {grokSetup ? (
                <>
                  <SettingsActionRow
                    icon="doc.on.doc"
                    label="Copy Grok Bot setup prompt"
                    onPress={() => void copyGrokBotSetup(grokSetup.prompt, "Grok Bot setup prompt")}
                  />
                  <SettingsActionRow
                    icon="chevron.left.forwardslash.chevron.right"
                    label="Copy MCP configuration"
                    onPress={() =>
                      void copyGrokBotSetup(grokSetup.configuration, "MCP configuration")
                    }
                  />
                </>
              ) : null}
            </SettingsSection>
            {!connected ? (
              <Text className="px-2 text-sm text-foreground-muted">
                Connect this environment to manage it.
              </Text>
            ) : !allowed ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {AsyncResult.isFailure(sessionResult)
                  ? "Could not verify your permissions. Reconnect to try again."
                  : session === null
                    ? "Checking permissions…"
                    : "This connection does not have permission to manage the environment."}
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            {notice ? <Text className="px-2 text-sm text-foreground-muted">{notice}</Text> : null}
            {config ? (
              <>
                <SettingsSection title="T3 Code">
                  <View className="gap-1 p-4">
                    <Text className="text-base text-foreground">Version {version}</Text>
                    {running ? (
                      <Text className="text-sm text-foreground-muted">
                        {updateState.stage === "resuming"
                          ? "Restarting and reconnecting…"
                          : "Downloading update…"}
                      </Text>
                    ) : updateState.status === "failed" ? (
                      <Text selectable className="text-sm text-danger-foreground">
                        {updateState.message}
                      </Text>
                    ) : null}
                    {checkedRelease ? (
                      <Text className="text-sm text-foreground-muted">
                        {checkedRelease.targetVersion
                          ? `Version ${checkedRelease.targetVersion} is available.`
                          : "You are up to date."}
                      </Text>
                    ) : null}
                    {!supportsEnvironmentUpdate(config.environment.capabilities) ? (
                      <Text className="text-sm text-foreground-muted">
                        {capabilities?.serverSelfUpdate === "desktop-managed"
                          ? "Update the desktop app on this machine."
                          : "Update and restart T3 Code on this machine."}
                      </Text>
                    ) : null}
                  </View>
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="Check for updates"
                    disabled={disabled}
                    loading={pending === "check"}
                    onPress={() => {
                      if (disabled) return;
                      void run("check", async () => {
                        const controller = new AbortController();
                        checkController.current = controller;
                        const timeout = setTimeout(() => controller.abort(), 20_000);
                        try {
                          const targetVersion = await findEnvironmentUpdate(
                            config.environment.serverVersion,
                            controller.signal,
                          );
                          setRelease({
                            fromVersion: config.environment.serverVersion,
                            targetVersion,
                          });
                        } finally {
                          clearTimeout(timeout);
                          checkController.current = null;
                        }
                      });
                    }}
                  />
                  {checkedRelease?.targetVersion &&
                  supportsEnvironmentUpdate(config.environment.capabilities) ? (
                    <SettingsActionRow
                      icon="arrow.up.circle"
                      label={`Update to ${checkedRelease.targetVersion}`}
                      disabled={disabled}
                      loading={pending === "server" || running}
                      onPress={requestServerUpdate}
                    />
                  ) : null}
                </SettingsSection>
                <SettingsSection title="Providers">
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="Refresh providers"
                    disabled={busy || !canRead}
                    loading={pending === "refresh"}
                    onPress={() => {
                      if (busy || !canRead) return;
                      void run("refresh", async () => {
                        if (!readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
                          return;
                        const result = await refreshProviders({ environmentId, input: {} });
                        if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                        setNotice("Provider status refreshed.");
                      });
                    }}
                  />
                  {config.providers
                    .filter((provider) => provider.enabled)
                    .map((provider) => (
                      <View key={provider.instanceId}>
                        <View className="gap-1 p-4">
                          <View className="flex-row items-center gap-2">
                            <ProviderIcon provider={provider.driver} size={18} />
                            <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
                              {provider.displayName ?? provider.driver}
                            </Text>
                          </View>
                          <Text className="text-sm text-foreground-muted">
                            {provider.installed
                              ? (provider.version ?? "Version unknown")
                              : "Not installed"}
                            {provider.versionAdvisory?.latestVersion
                              ? ` · Latest ${provider.versionAdvisory.latestVersion}`
                              : ""}
                          </Text>
                          {provider.updateState && provider.updateState.status !== "idle" ? (
                            <Text
                              selectable
                              className={
                                provider.updateState.status === "failed"
                                  ? "text-sm text-danger-foreground"
                                  : "text-sm text-foreground-muted"
                              }
                            >
                              {provider.updateState.message ??
                                `Update ${provider.updateState.status}`}
                            </Text>
                          ) : null}
                          {provider.compatibilityAdvisory?.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {provider.compatibilityAdvisory.message}
                            </Text>
                          ) : null}
                          {provider.unavailableReason || provider.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {provider.unavailableReason ?? provider.message}
                            </Text>
                          ) : null}
                          {provider.versionAdvisory?.status === "behind_latest" &&
                          !provider.versionAdvisory.canUpdate ? (
                            <Text className="text-sm text-foreground-muted">
                              Update this provider on the environment's machine.
                            </Text>
                          ) : null}
                        </View>
                        {canUpdateEnvironmentProvider(provider) ? (
                          <SettingsActionRow
                            icon="arrow.up.circle"
                            label={`Update ${provider.displayName ?? provider.driver}`}
                            disabled={busy || !canManageProviders}
                            loading={pending === provider.instanceId}
                            onPress={() => requestProviderUpdate(provider)}
                          />
                        ) : null}
                      </View>
                    ))}
                </SettingsSection>
              </>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
