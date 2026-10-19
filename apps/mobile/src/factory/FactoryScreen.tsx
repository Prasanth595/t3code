import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { ListSection } from "../components/ui/ListSection";
import type { SavedRemoteConnection } from "../lib/connection";
import { useSavedRemoteConnections } from "../state/use-remote-environment-registry";
import {
  FACTORY_NO_ENVIRONMENT_MESSAGE,
  FACTORY_RELAY_ONLY_MESSAGE,
  factoryEnvironmentChoice,
} from "./factoryEnvironments";
import {
  factoryLinkAction,
  mintPairingToken,
  parseFactoryMessage,
  probeFactory,
  signInDecision,
} from "./factorySignIn";
import {
  FACTORY_BEFORE_CONTENT_LOADED_SCRIPT,
  factoryExchangeScript,
} from "./factoryWebViewScripts";

function Message(props: { readonly text: string; readonly onRetry?: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-screen px-8">
      <AppText textRole="body" className="text-center text-foreground-muted">
        {props.text}
      </AppText>
      {props.onRetry ? <Button tone="primary" label="Retry" onPress={props.onRetry} /> : null}
    </View>
  );
}

export function FactoryScreen() {
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const [pickedId, setPickedId] = useState<string | null>(null);

  if (isLoadingSavedConnection) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <AppActivityIndicator />
      </View>
    );
  }

  const choice = factoryEnvironmentChoice(Object.values(savedConnectionsById));
  switch (choice.kind) {
    case "none":
      return <Message text={FACTORY_NO_ENVIRONMENT_MESSAGE} />;
    case "relay-only":
      return <Message text={FACTORY_RELAY_ONLY_MESSAGE} />;
    case "one":
      return <FactoryWebView connection={choice.connection} />;
    case "several": {
      const picked = choice.connections.find((c) => c.environmentId === pickedId);
      if (picked) return <FactoryWebView connection={picked} />;
      return (
        <View className="flex-1 bg-screen px-5 pt-4">
          <ListSection title="Environment">
            {choice.connections.map((connection) => (
              <ListRow
                key={connection.environmentId}
                icon="desktopcomputer"
                label={connection.environmentLabel}
                onPress={() => setPickedId(connection.environmentId)}
              />
            ))}
          </ListSection>
        </View>
      );
    }
  }
}

type Phase =
  | { readonly kind: "probing" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "ready" };

function FactoryWebView(props: { readonly connection: SavedRemoteConnection }) {
  const { httpBaseUrl, bearerToken } = props.connection;
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [attempt, setAttempt] = useState(0);
  const webViewRef = useRef<WebView<object>>(null);
  // One sign-in per open. A sign-in that ends unauthenticated again must not mint again.
  const signedInRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    signedInRef.current = false;
    setPhase({ kind: "probing" });
    void probeFactory({ httpBaseUrl, bearerToken }, fetch).then((result) => {
      if (!cancelled)
        setPhase(result.ok ? { kind: "ready" } : { kind: "error", reason: result.reason });
    });
    return () => {
      cancelled = true;
    };
  }, [httpBaseUrl, bearerToken, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const message = parseFactoryMessage(event.nativeEvent.data);
      if (message === null) return;
      if (message.type === "exchange") {
        if (!message.ok)
          setPhase({ kind: "error", reason: "Signing in to the Factory pages failed." });
        return;
      }
      const decision = signInDecision(message, httpBaseUrl, signedInRef.current);
      if (decision === "failed") {
        setPhase({ kind: "error", reason: "The server did not accept the sign-in." });
      } else if (decision === "sign-in") {
        signedInRef.current = true;
        const minted = await mintPairingToken({ httpBaseUrl, bearerToken }, fetch);
        if (!minted.ok) {
          setPhase({ kind: "error", reason: minted.reason });
          return;
        }
        webViewRef.current?.injectJavaScript(factoryExchangeScript(minted.credential));
      }
    },
    [httpBaseUrl, bearerToken],
  );

  if (phase.kind === "error") return <Message text={phase.reason} onRetry={retry} />;
  if (phase.kind === "probing") {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <WebView<object>
      ref={webViewRef}
      source={{ uri: `${httpBaseUrl}/factory` }}
      originWhitelist={["*"]}
      sharedCookiesEnabled
      injectedJavaScriptBeforeContentLoaded={FACTORY_BEFORE_CONTENT_LOADED_SCRIPT}
      onMessage={(event) => void onMessage(event)}
      onShouldStartLoadWithRequest={(request) => {
        if (request.isTopFrame === false) return true;
        if (factoryLinkAction(request.url, httpBaseUrl) === "webview") return true;
        void Linking.openURL(request.url).catch(() => undefined);
        return false;
      }}
      onError={() => setPhase({ kind: "error", reason: "The server is unreachable." })}
      onHttpError={(event) =>
        setPhase({
          kind: "error",
          reason: `The server returned an error (${event.nativeEvent.statusCode}).`,
        })
      }
    />
  );
}
