import {
  type OrchestrationMessageContext,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class ProviderInputTooLongError extends Schema.TaggedError<ProviderInputTooLongError>()(
  "ProviderInputTooLongError",
  { inputLength: Schema.Number },
) {
  override get message(): string {
    const excess = this.inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
    return `Message is ${excess.toLocaleString("en-US")} ${excess === 1 ? "character" : "characters"} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit once assistant quotes are expanded. Shorten it or quote less.`;
  }
}

// Project context before expanding quotes, including citations inside context records.
// The durable message keeps its clickable links.
export const providerUserMessageText = (message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}): Effect.Effect<string, ProviderInputTooLongError> => {
  const projected = projectComposerContextForProvider({
    text: message.text,
    records: message.context?.records ?? [],
  });
  const text = expandAssistantCitationsForProvider(projected);
  return text !== projected && text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ? Effect.fail(new ProviderInputTooLongError({ inputLength: text.length }))
    : Effect.succeed(text);
};
