import type { OrchestrationV2InternalCommand, TurnItemId } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

type VoiceTranscriptCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "voice_transcript.record" }
>;

const provenance = ({ role }: VoiceTranscriptCommand) => ({
  createdBy: role === "user" ? ("user" as const) : ("agent" as const),
  creationSource: "server" as const,
});

export const voiceTranscriptMessage = (
  command: VoiceTranscriptCommand,
  at: { readonly startedAt: DateTime.Utc; readonly now: DateTime.Utc },
) => ({
  ...provenance(command),
  id: command.messageId,
  threadId: command.threadId,
  runId: null,
  nodeId: null,
  role: command.role,
  text: command.text,
  attachments: [],
  streaming: command.streaming,
  createdAt: at.startedAt,
  updatedAt: at.now,
});

export const voiceTranscriptTurnItem = (
  command: VoiceTranscriptCommand,
  at: {
    readonly itemId: TurnItemId;
    readonly ordinal: number;
    readonly startedAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  },
) => {
  const turnItem = {
    ...provenance(command),
    id: at.itemId,
    threadId: command.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: at.ordinal,
    status: "completed",
    title: null,
    startedAt: at.startedAt,
    completedAt: at.now,
    updatedAt: at.now,
    messageId: command.messageId,
    text: command.text,
  } as const;
  return command.role === "user"
    ? ({ ...turnItem, type: "user_message", inputIntent: "turn_start", attachments: [] } as const)
    : ({ ...turnItem, type: "assistant_message", streaming: command.streaming } as const);
};
