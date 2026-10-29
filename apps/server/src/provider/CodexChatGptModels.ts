import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { mapCodexModelCapabilities } from "./CodexProvider.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
      default_reasoning_level: Schema.optionalKey(Schema.String),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.Array(Schema.Struct({ effort: Schema.String, description: Schema.String })),
      ),
    }),
  ),
});

// Models newer than the managed Codex CLI are missing from its native catalog,
// so fall back to the reasoning levels OpenAI advertises for them.
function catalogCapabilities(model: (typeof Catalog.Type)["models"][number]) {
  const supportedReasoningEfforts = (model.supported_reasoning_levels ?? [])
    .filter(({ effort }) => effort.length > 0)
    .map(({ effort, description }) => ({ reasoningEffort: effort, description }));
  if (supportedReasoningEfforts.length === 0) return null;
  return mapCodexModelCapabilities({
    model: model.slug,
    defaultReasoningEffort: model.default_reasoning_level ?? "",
    supportedReasoningEfforts,
  });
}

export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map(
      (model) =>
        ({
          ...nativeModels.find((native) => native.slug === model.slug),
          capabilities:
            nativeModels.find((native) => native.slug === model.slug)?.capabilities ??
            catalogCapabilities(model),
          slug: model.slug,
          name: model.display_name,
          isCustom: false,
        }) satisfies ServerProviderModel,
    );
}, Effect.timeout("15 seconds"));
