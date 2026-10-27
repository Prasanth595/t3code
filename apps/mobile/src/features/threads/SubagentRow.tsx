import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { subagentCardDetail } from "./subagent-card-presentation";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import {
  resolveSubagentRowPresentation,
  resolveSubagentTraits,
  type SubagentTraits,
} from "./threadAgentsPresentation";

const ThemedPath = withUniwind(Path);

type SubagentRowSubagent = Pick<
  OrchestrationV2Subagent,
  | "threadId"
  | "childThreadId"
  | "model"
  | "modelSelection"
  | "origin"
  | "driver"
  | "providerInstanceId"
  | "title"
  | "prompt"
  | "status"
  | "progress"
  | "result"
>;

export function SubagentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
  readonly elapsed: ReactNode;
}) {
  const presentation = resolveSubagentRowPresentation(props.subagent);
  const detail = subagentCardDetail(presentation.detail);
  return (
    <View className="flex-row gap-3">
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={presentation.tone} placement="sheet" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text
              numberOfLines={1}
              className="min-w-0 shrink font-t3-medium text-sm text-foreground"
            >
              {presentation.title}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="shrink-0 text-xs text-foreground-muted"
            >
              ·
            </Text>
            <Text
              className={cn(
                "shrink-0 text-xs font-t3-medium",
                SUBAGENT_TONE_TEXT_CLASS[presentation.tone],
              )}
            >
              {presentation.statusLabel}
            </Text>
          </View>
          {props.elapsed}
          {presentation.canOpenThread ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : null}
        </View>
        <SubagentMetadata environmentId={props.environmentId} subagent={props.subagent} />
        {detail ? (
          <Text
            numberOfLines={3}
            className={cn(
              "text-xs text-foreground-muted",
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SubagentMetadata(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
}) {
  const { environmentId, subagent } = props;
  const config = useEnvironmentServerConfig(environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const parent = useThreadShell(scopeThreadRef(environmentId, subagent.threadId))?.source;
  const child = useThreadShell(
    subagent.childThreadId === null ? null : scopeThreadRef(environmentId, subagent.childThreadId),
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  const { modelLabel, workspace } = resolveSubagentMetadata({
    model: subagent.model,
    provider,
    parentThread: parent,
    childThread: child,
    parentProject,
    childProject,
  });
  const traits = resolveSubagentTraits({ subagent, provider, childThread: child });
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      <ProviderIcon
        provider={provider?.driver ?? subagent.driver}
        iconUrl={provider?.iconUrl}
        size={12}
      />
      <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
        {provider ? `${resolveProviderInstanceDisplayName(provider)} · ` : ""}
        {modelLabel}
      </Text>
      <SubagentTraitsLabel traits={traits} />
      {workspace.map(({ label, value }) => (
        // Preserve the label against flattening without making it a separate accessibility stop.
        <View
          key={label}
          collapsable={false}
          accessibilityLabel={`${label}: ${value}`}
          className="min-w-0 shrink flex-row items-center gap-1.5"
        >
          <Text className="text-xs text-foreground-muted">·</Text>
          <SymbolView
            name={label === "Branch" ? "arrow.triangle.branch" : "folder"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SubagentTraitsLabel(props: { readonly traits: SubagentTraits }) {
  const { effort, speedIcon } = props.traits;
  if (!effort && !speedIcon) return null;
  const speedLabel =
    speedIcon === "ultrafast" ? "Ultrafast mode on" : speedIcon ? "Fast mode on" : null;
  return (
    <View
      accessible
      collapsable={false}
      accessibilityLabel={[speedLabel, effort].filter(Boolean).join(", ")}
      className="min-w-0 shrink flex-row items-center gap-1"
    >
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        className="shrink-0 text-xs text-foreground-muted"
      >
        ·
      </Text>
      {speedIcon ? <SpeedIcon speedIcon={speedIcon} /> : null}
      {effort ? (
        <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
          {effort}
        </Text>
      ) : null}
    </View>
  );
}

// Same glyphs as the desktop composer's speed icons.
function SpeedIcon(props: { readonly speedIcon: "fast" | "ultrafast" }) {
  return (
    <Svg width={11} height={11} viewBox="0 0 24 24" opacity={0.8}>
      {props.speedIcon === "ultrafast" ? (
        <>
          <ThemedPath
            d="m17 2-10 12h7l-1 8 10-12h-7l1-8Z"
            colorClassName="accent-foreground-muted"
            fill="currentColor"
            opacity={0.4}
          />
          <ThemedPath
            d="m11 2-10 12h7l-1 8 10-12h-7l1-8Z"
            colorClassName="accent-foreground-muted"
            fill="currentColor"
          />
        </>
      ) : (
        <ThemedPath
          d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"
          colorClassName="accent-foreground-muted"
          fill="currentColor"
        />
      )}
    </Svg>
  );
}
