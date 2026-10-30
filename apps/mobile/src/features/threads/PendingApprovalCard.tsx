import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly maxHeight: number;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

// Card padding, border and the gap between the body and the footer.
const CARD_CHROME_HEIGHT = 44;
// Keeps the request readable when its pinned buttons need most of the card.
const MIN_BODY_HEIGHT = 96;

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [footerHeight, setFooterHeight] = useState(0);
  const handleFooterLayout = (event: LayoutChangeEvent) => {
    setFooterHeight(event.nativeEvent.layout.height);
  };
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <ScrollView
        bounces={false}
        contentContainerClassName="gap-2.5"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{
          maxHeight: Math.max(MIN_BODY_HEIGHT, props.maxHeight - footerHeight - CARD_CHROME_HEIGHT),
        }}
      >
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          Approval needed
        </Text>
        <Text className="font-t3-bold text-lg text-foreground">
          {props.approval.appName ?? props.approval.requestKind}
        </Text>
        {props.approval.detail ? (
          <Text className="font-sans text-sm leading-normal text-foreground-secondary">
            {props.approval.detail}
          </Text>
        ) : null}
        {props.approval.reason ? (
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {props.approval.reason}
          </Text>
        ) : null}
        {props.approval.fullAccessOverride ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: explanationOpen }}
            onPress={() => setExplanationOpen((open) => !open)}
          >
            <Text className="font-t3-bold text-xs text-foreground-secondary underline">
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </Text>
            {explanationOpen ? (
              <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
                {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </Text>
        ) : null}
      </ScrollView>
      <View className="gap-2.5" onLayout={handleFooterLayout}>
        {warning ? (
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {warning}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2.5">
          {options.map((option) => (
            <Button
              key={option.decision}
              label={option.label}
              tone={
                option.decision === "accept"
                  ? "primary"
                  : option.decision === "decline"
                    ? "danger"
                    : "secondary"
              }
              disabled={disabled || !props.canOperateThread}
              onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
            />
          ))}
        </View>
        {!props.canOperateThread ? (
          <Text className="font-sans text-xs text-foreground-muted">
            This connection cannot respond to approvals.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
