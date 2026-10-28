import { Pressable, View } from "react-native";
import {
  compactTrajectoryLabel,
  type AgentTrajectorySummary,
} from "@t3tools/client-runtime/work-log/trajectory-summary";

import { AppText as Text } from "../../components/ui/AppText";
import { alert } from "../../components/ui/Dialog";

export function ThreadTrajectorySegments({
  summary,
  compact = false,
  measurement = false,
}: {
  readonly summary: AgentTrajectorySummary;
  readonly compact?: boolean;
  readonly measurement?: boolean;
}) {
  const Segment = measurement ? View : Pressable;
  return summary.map((segment) => {
    const label = compact ? compactTrajectoryLabel(segment.label) : segment.label;
    return (
      <View key={segment.kind} className="flex-row items-center gap-x-1">
        <Text accessible={false} className="text-sm text-foreground-muted">
          ·
        </Text>
        <Segment
          accessibilityRole="button"
          accessibilityLabel={segment.label}
          accessibilityHint="Show breakdown"
          onPress={measurement ? undefined : () => alert(segment.title, segment.details.join("\n"))}
          className="min-h-11 justify-center px-1"
        >
          <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">{label}</Text>
        </Segment>
      </View>
    );
  });
}
