import { useAtomValue } from "@effect/atom-react";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  deriveThreadSwarmGroups,
  filterSwarmMemberTasks,
  type ThreadSwarmGroup,
} from "@t3tools/client-runtime/state/thread-swarms";
import {
  isOrchestrationV2WorkActive,
  CommandId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ArchivedShellSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { SubagentRow } from "./SubagentRow";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const EMPTY_ARCHIVED_SWARM_SHELL_ATOM = Atom.make(
  AsyncResult.initial<OrchestrationV2ArchivedShellSnapshot, never>(),
);

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function useThreadTurnSubagents(target: AgentsTarget): ThreadTurnSubagents | null {
  return useAtomValue(environmentThreadDetails.turnSubagentsAtom(target));
}

export function useThreadSwarmGroups(target: AgentsTarget): ReadonlyArray<ThreadSwarmGroup> {
  const projection = useAtomValue(environmentThreadDetails.threadAtom(target))?.projection;
  const threads = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(target.environmentId),
  );
  const archived = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        (projection?.swarms?.length ?? 0) > 0
          ? orchestrationEnvironment.archivedShellSnapshot({
              environmentId: target.environmentId,
              input: {},
            })
          : EMPTY_ARCHIVED_SWARM_SHELL_ATOM,
      ),
    ),
  );
  return useMemo(
    () =>
      deriveThreadSwarmGroups({
        ownerThreadId: target.threadId,
        swarms: projection?.swarms ?? [],
        tasks: projection?.subagents ?? [],
        threads: [...threads, ...(archived?.threads ?? [])],
      }),
    [target.threadId, projection?.swarms, projection?.subagents, threads, archived?.threads],
  );
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const turn = useThreadTurnSubagents(target);
  const swarmGroups = useThreadSwarmGroups(target);
  const subagents = filterSwarmMemberTasks(
    turn?.subagents ?? [],
    swarmGroups.map((group) => group.swarm),
  );
  const hasLiveAgent = (turn?.liveCount ?? 0) > 0;
  const [visibleSwarmCount, setVisibleSwarmCount] = useState(6);

  const openChildThread = (childThreadId: ThreadId, focusComposer = false) => {
    void Haptics.selectionAsync();
    // Replace rather than push: the sheet is a leaf, and the child thread
    // belongs in the workspace stack where Home's back button expects it.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
        focusComposer,
      }),
    );
  };

  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {swarmGroups.slice(0, visibleSwarmCount).map((group) => (
        <SwarmGroup key={group.swarm.id} group={group} target={target} onOpen={openChildThread} />
      ))}
      {swarmGroups.length > visibleSwarmCount ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setVisibleSwarmCount((count) => count + 12)}
          className="min-h-11 justify-center active:opacity-70"
        >
          <Text className="font-t3-medium text-sm text-foreground-muted">
            Show {Math.min(12, swarmGroups.length - visibleSwarmCount)} more swarms
          </Text>
        </Pressable>
      ) : null}
      {subagents.length === 0 && swarmGroups.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No agents in this turn.
        </Text>
      ) : (
        subagents.map((subagent) => (
          <AgentRow
            key={subagent.id}
            subagent={subagent}
            environmentId={target.environmentId}
            tickSeconds={hasLiveAgent}
            onOpen={openChildThread}
          />
        ))
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the git sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Agents" onBack={() => navigation.goBack()} />
      <MaterialScreenContent insetHorizontal={layout.usesSplitView}>
        {content}
      </MaterialScreenContent>
    </View>
  );
}

function SwarmGroup(props: {
  readonly group: ThreadSwarmGroup;
  readonly target: AgentsTarget;
  readonly onOpen: (threadId: ThreadId, focusComposer?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const supported = useAtomValue(
    serverEnvironment.nativeSwarmsSupportedAtom(props.target.environmentId),
  );
  const canOperate = useAtomValue(
    orchestrationEnvironment.stopSwarm.permissionAtom(props.target.environmentId),
  );
  const stopGroup = useAtomCommand(orchestrationEnvironment.stopSwarm, "stop swarm");
  const stopMember = useAtomCommand(threadEnvironment.interruptTurn, "stop swarm member");
  const { group } = props;
  const stop = async (threadId?: ThreadId) => {
    if (stoppingId !== null || !canOperate || (threadId === undefined && !supported)) return;
    setStoppingId(threadId ?? group.swarm.id);
    try {
      if (threadId)
        await stopMember({ environmentId: props.target.environmentId, input: { threadId } });
      else
        await stopGroup({
          environmentId: props.target.environmentId,
          input: {
            threadId: group.swarm.ownerThreadId,
            swarmId: group.swarm.id,
            commandId: CommandId.make(uuidv4()),
          },
        });
    } finally {
      setStoppingId(null);
    }
  };
  return (
    <View className="border-b border-border py-2">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`Swarm ${group.swarm.title}, ${group.members.length} members, ${group.summary}`}
          onPress={() => setExpanded((value) => !value)}
          className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
        >
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-subtle"
          />
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
              Swarm · {group.swarm.title}
            </Text>
            <Text
              className={
                group.inputCount > 0 ? "text-xs text-primary" : "text-xs text-foreground-muted"
              }
            >
              {group.members.length} members · {group.summary}
            </Text>
          </View>
        </Pressable>
        {supported && canOperate && group.swarm.lifecycle.state === "open" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop swarm ${group.swarm.title}`}
            accessibilityState={{ disabled: stoppingId !== null }}
            disabled={stoppingId !== null}
            onPress={() => void stop()}
            className="min-h-11 justify-center px-2 active:opacity-70 disabled:opacity-40"
          >
            <Text className="font-t3-medium text-xs text-danger-foreground">
              {stoppingId === group.swarm.id ? "Stopping" : "Stop"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <View className="pl-5">
          {group.members.map((member) => (
            <View key={member.member.threadId} className="border-t border-border py-2">
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Open ${member.title} chat`}
                disabled={!member.canOpen}
                onPress={() => props.onOpen(member.member.threadId)}
                className="min-h-11 justify-center active:opacity-70"
              >
                {member.task ? (
                  <SubagentRow
                    environmentId={props.target.environmentId}
                    subagent={{ ...member.task, title: member.title, status: member.status }}
                    elapsed={<AgentElapsed subagent={member.task} tickSeconds={member.working} />}
                  />
                ) : (
                  <Text className="font-t3-medium text-sm text-foreground">{member.title}</Text>
                )}
              </Pressable>
              {member.thread === null ? (
                <Text className="text-xs text-foreground-muted">
                  Thread unavailable. Task history remains in the parent transcript.
                </Text>
              ) : null}
              {member.member.admission.state === "revoked" ? (
                <Text className="text-xs text-foreground-muted">Peer access revoked</Text>
              ) : null}
              {member.queuedCount > 0 ? (
                <Text className="text-xs text-foreground-muted">
                  {member.queuedCount} queued
                  {member.heldCount > 0 ? `, ${member.heldCount} held` : ""}
                </Text>
              ) : null}
              {member.inputThreads.map((thread) => (
                <Pressable
                  key={thread.id}
                  accessibilityRole="button"
                  onPress={() => props.onOpen(thread.id)}
                  className="min-h-11 justify-center active:opacity-70"
                >
                  <Text className="font-t3-medium text-xs text-primary">
                    Open question · {thread.title}
                  </Text>
                </Pressable>
              ))}
              {canOperate ? (
                <View className="flex-row gap-4">
                  {member.canMessage ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Message ${member.title}`}
                      onPress={() => props.onOpen(member.member.threadId, true)}
                      className="min-h-11 justify-center active:opacity-70"
                    >
                      <Text className="font-t3-medium text-xs text-primary">Message</Text>
                    </Pressable>
                  ) : null}
                  {member.canStop ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Stop subagent ${member.title}`}
                      disabled={stoppingId !== null}
                      onPress={() => void stop(member.member.threadId)}
                      className="min-h-11 justify-center active:opacity-70 disabled:opacity-40"
                    >
                      <Text className="font-t3-medium text-xs text-danger-foreground">
                        {stoppingId === member.member.threadId ? "Stopping" : "Stop"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const { subagent } = props;
  const childThreadId = subagent.childThreadId;

  const row = (
    <View className="border-b border-border py-3.5">
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        elapsed={<AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />}
      />
    </View>
  );

  if (childThreadId === null) {
    return (
      <View
        accessible
        accessibilityHint="Provider-managed agent. Its work appears in the transcript."
      >
        {row}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens this agent's thread"
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  );
}

/**
 * Elapsed time for one agent. Only live work ticks, inside AgentElapsed,
 * so the timer never repaints the metadata or a settled sheet.
 */
function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isOrchestrationV2WorkActive(subagent.status);
  useEffect(() => {
    if (!tickSeconds || !running) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [running, tickSeconds]);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
