import type {
  EnvironmentId,
  UserInputAttachmentAnswerPayload,
  UserInputAttachments,
} from "@t3tools/contracts";
import { Image, Linking, Pressable, View } from "react-native";
import { getQuestionAnswerText, getQuestionIds } from "@t3tools/client-runtime/work-log/user-input";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAssetUrl } from "../../state/assets";

function AnswerFile(props: {
  environmentId: EnvironmentId;
  attachment: UserInputAttachments[string][number];
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
  });
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.attachment.name}
      disabled={!url}
      onPress={() => {
        if (url) void Linking.openURL(url);
      }}
      className="gap-1"
    >
      {props.attachment.type === "image" && url ? (
        <Image source={{ uri: url }} style={{ width: 160, height: 96 }} resizeMode="contain" />
      ) : null}
      <Text className="text-sm text-foreground underline">{props.attachment.name}</Text>
    </Pressable>
  );
}

export function QuestionAnswerHistory(props: {
  environmentId: EnvironmentId;
  answer: UserInputAttachmentAnswerPayload;
}) {
  return (
    <View className="overflow-hidden rounded-lg border border-border bg-card">
      {getQuestionIds(props.answer).map((questionId, index) => {
        const text = getQuestionAnswerText(props.answer.answers[questionId]);
        const attachments = props.answer.attachmentsByQuestionId[questionId] ?? [];
        return (
          <View
            key={questionId}
            className={index > 0 ? "gap-1 border-t border-border px-3 py-2.5" : "gap-1 px-3 py-2.5"}
          >
            {props.answer.questionTextById?.[questionId] ? (
              <Text className="text-sm text-foreground-muted">
                {props.answer.questionTextById[questionId]}
              </Text>
            ) : null}
            {text || attachments.length > 0 ? (
              <View className="flex-row gap-1.5">
                <View className="h-5 justify-center">
                  <SymbolView
                    name="arrow.turn.down.right"
                    size={12}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                </View>
                <View className="min-w-0 flex-1 gap-1">
                  {text ? (
                    <Text className="font-t3-medium text-sm text-foreground">{text}</Text>
                  ) : null}
                  {attachments.map((attachment) => (
                    <AnswerFile
                      key={attachment.id}
                      environmentId={props.environmentId}
                      attachment={attachment}
                    />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
