import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useThreadListActions } from "../home/useThreadListActions";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { buildThreadTitleMenu, threadTitleSnoozeUntil } from "./thread-title-menu";
import { ThreadTitleMenuTrigger } from "./ThreadTitleMenuTrigger";
import { View } from "react-native";

export function ThreadTitleMenu(props: {
  readonly thread: EnvironmentThreadShell;
  readonly subtitle: string;
}) {
  const { thread } = props;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const queuedKeys = useAtomValue(queuedThreadKeysAtom);
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const handlers = useThreadListActions();
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      const timer = setInterval(() => setNow(new Date()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const actions = buildThreadTitleMenu({
    thread,
    capabilities: configs.get(thread.environmentId)?.environment.capabilities,
    canOperate,
    hasQueuedMessages: queuedKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
    now,
  });
  const snooze = (until: string) => {
    void handlers.snoozeThread(thread, until);
  };
  return (
    <>
      <ThreadTitleMenuTrigger
        actions={actions}
        title={thread.title}
        onOpen={() => setNow(new Date())}
        onAction={(event) => {
          switch (event) {
            case "settle":
              void handlers.settleThread(thread);
              return;
            case "unsettle":
              void handlers.unsettleThread(thread);
              return;
            case "unsnooze":
              void handlers.unsnoozeThread(thread);
              return;
            case "pin":
              void handlers.pinThread(thread);
              return;
            case "unpin":
              void handlers.unpinThread(thread);
              return;
            case "rename":
              handlers.renameThread(thread);
              return;
            case "regenerate-title":
              void handlers.regenerateThreadTitle(thread);
              return;
            case "delete":
              handlers.confirmDeleteThread(thread);
              return;
            case "copy-thread-id":
              void copyTextWithHaptic(thread.id, { target: "thread-id" });
              return;
            case "snooze:custom":
              setCustomSnoozeOpen(true);
              return;
          }
          const until = threadTitleSnoozeUntil(event, new Date());
          if (until !== null) snooze(until);
          else if (event.startsWith("snooze:"))
            Dialog.alert(
              "Could not snooze thread",
              "That snooze time has passed. Choose another time.",
            );
        }}
      >
        <View className="min-w-0 items-center">
          <View className="flex-row items-center gap-1">
            <AppText
              numberOfLines={1}
              className="shrink text-[17px] font-t3-bold text-header-foreground"
            >
              {thread.title}
            </AppText>
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName="accent-foreground-muted"
            />
          </View>
          {props.subtitle ? (
            <AppText numberOfLines={1} className="text-xs text-foreground-muted">
              {props.subtitle}
            </AppText>
          ) : null}
        </View>
      </ThreadTitleMenuTrigger>
      {customSnoozeOpen ? (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={snooze} />
      ) : null}
    </>
  );
}
