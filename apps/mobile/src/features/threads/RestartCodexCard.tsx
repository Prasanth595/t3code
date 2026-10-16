import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

export function RestartCodexCard({
  environmentId,
  threadId,
  retryRunId,
  continueWork = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  retryRunId: RunId;
  continueWork?: boolean;
}) {
  const restart = useAtomCommand(orchestrationEnvironment.restartCodex, { reportFailure: false });
  const allowed = useAtomValue(orchestrationEnvironment.restartCodex.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-screen p-3">
      <Pressable
        accessibilityRole="button"
        disabled={!allowed || pending}
        accessibilityState={{ disabled: !allowed || pending, busy: pending }}
        className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
        onPress={async () => {
          if (pending) return;
          setPending(true);
          setMessage(null);
          try {
            const result = await restart({ environmentId, input: { threadId, retryRunId } });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            Alert.alert(continueWork ? "Conversation continued" : "Message resent");
          } catch (cause) {
            setMessage(
              cause instanceof Error ? cause.message : "Could not recover the conversation.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <Text className="text-sm text-foreground">
          {pending
            ? continueWork
              ? "Continuing…"
              : "Retrying message…"
            : continueWork
              ? "Continue"
              : "Retry message"}
        </Text>
      </Pressable>
      {message ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
