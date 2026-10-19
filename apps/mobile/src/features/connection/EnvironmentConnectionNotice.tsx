import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import { connectionNoticeAction } from "./connectionNoticeAction";
import { usePairAgain } from "./forkPairAgain";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return "You are offline";
    case "connecting":
      return `Connecting to ${environmentLabel}...`;
    case "reconnecting":
      return `Reconnecting to ${environmentLabel}...`;
    case "unsupported":
      return "Client not supported";
    case "error":
      return `${environmentLabel} is unavailable`;
    case "available":
      return `${environmentLabel} is disconnected`;
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
): string {
  if (error) {
    return phase === "reconnecting" ? `The app will keep retrying automatically. ${error}` : error;
  }

  switch (phase) {
    case "offline":
      return `Cached data remains available. The ${resourceName} will load when your connection returns.`;
    case "connecting":
    case "reconnecting":
      return `The ${resourceName} will load as soon as the environment is ready.`;
    case "unsupported":
      return "Use compatible versions of the app and server to connect.";
    case "available":
    case "error":
      return `Reconnect the environment to load the ${resourceName}.`;
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";
  // Fork: a refused pairing offers "Pair again" instead of "Retry now" (forkPairAgain.ts).
  const action = connectionNoticeAction(props.connection);
  const pairAgain = usePairAgain();

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <AppActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resourceName, props.connection.error)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {action !== null ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={action === "pair-again" ? pairAgain : props.onRetry}
          >
            <Text className="text-sm font-t3-bold text-foreground">
              {action === "pair-again" ? "Pair again" : "Retry now"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
