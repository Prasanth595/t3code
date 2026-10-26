import type * as EffectAcpSchema from "effect-acp/compat";

// Trimmed from ACP 1.4.3 session/new for a personal Google account on the
// third-party model allowlist.
export const antigravity143Session = {
  sessionId: "8e3c4b2a-7f61-4d0e-9a55-2b1f0c6d9e47",
  models: {
    currentModelId: "gemini-3.8-flash-high",
    availableModels: [
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { modelId: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
      { modelId: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
      { modelId: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
      { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-3.8-flash",
      options: [
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    {
      id: "thinking_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;
