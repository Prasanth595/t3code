interface AntigravityUsageModelDescriptor {
  readonly family: "gemini" | "claude" | "gpt-oss";
  readonly rateModel: string;
  readonly thinkingLevels: readonly string[];
  // Logical groups, not wire bucket IDs or a reset-cadence policy.
  readonly usageBucket: "gemini" | "claude-gpt" | "argon";
  readonly idAliases: readonly number[];
}

const LEGACY_THINKING_LEVELS = ["low", "medium", "high"] as const;

function model(
  family: AntigravityUsageModelDescriptor["family"],
  rateModel: string,
  idAliases: readonly number[],
  thinkingLevels: readonly string[] = LEGACY_THINKING_LEVELS,
  usageBucket: AntigravityUsageModelDescriptor["usageBucket"] = family === "gemini"
    ? "gemini"
    : "claude-gpt",
): AntigravityUsageModelDescriptor {
  return { family, rateModel, idAliases, thinkingLevels, usageBucket };
}

// Historical numeric aliases and effort normalization are retained from the reader.
// This is usage identity, never a selectable-model catalog or account advertisement.
const MODELS = [
  model("gemini", "gemini-2.5-pro", [246]),
  model("gemini", "gemini-2.5-flash", [312]),
  model("gemini", "gemini-2.5-flash-thinking", [313, 329]),
  model("gemini", "gemini-2.5-flash-lite", [330]),
  model("claude", "claude-sonnet-4", [281, 282]),
  model("claude", "claude-opus-4", [290, 291]),
  model("claude", "claude-sonnet-4-5", [333, 334]),
  model("claude", "claude-haiku-4-5", [340, 341]),
  model("claude", "claude-opus-4-6", [1026]),
  model("claude", "claude-sonnet-4-6", [1035]),
  model("gemini", "gemini-3-pro", []),
  model("gemini", "gemini-3.1-pro", [1016, 1036, 1037]),
  model("gemini", "gemini-3-flash-preview", [1018, 1084, 1047]),
  // ACP 1.4 capture: antigravity140.fixture.ts. No captured numeric IDs for new models.
  model("gemini", "gemini-3.8-flash", [], ["low", "medium", "high"]),
  // https://discuss.ai.google.dev/t/argon-on-antigravity/189395/2 (separate Pro quota)
  // https://discuss.ai.google.dev/t/google-loads-of-people-need-answers-for-the-new-completely-destroyed-antigravity/189699/4 (Argon Medium/High)
  // https://antigravity.google/docs/models (Claude 5.5, GPT-OSS)
  model("gemini", "gemini-4-argon", [], ["medium", "high"], "argon"),
  model("gpt-oss", "gpt-oss-120b", [], ["medium"]),
  model("claude", "claude-sonnet-5-5", [], []),
  model("claude", "claude-opus-5-5", [], []),
];

const MODELS_BY_ID = new Map(
  MODELS.flatMap((descriptor) => descriptor.idAliases.map((id) => [id, descriptor] as const)),
);
const MODELS_BY_NAME = new Map(
  MODELS.flatMap((descriptor) =>
    [
      descriptor.rateModel,
      ...descriptor.thinkingLevels.map((level) => `${descriptor.rateModel}-${level}`),
    ].map((name) => [name, descriptor] as const),
  ),
);

export const antigravityUsageModelFromId = (id: number): string | undefined =>
  MODELS_BY_ID.get(id)?.rateModel;

export const findAntigravityUsageModel = (
  name: string,
): AntigravityUsageModelDescriptor | undefined => MODELS_BY_NAME.get(name);
