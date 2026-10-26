import type * as AcpSchema from "effect-acp/compat";

// IDs/names/order captured from fetchAvailableModels on 2026-10-26. This is a
// synthetic ACP advertisement: 1.4.0 filters Claude/GPT-OSS for T3's identity.
// Its unmodified config_options.py groups only Gemini; selecting GPT-OSS omits
// thinking_level. Mode options/descriptions are omitted; session ID is synthetic.
export const antigravityThirdPartySession = {
  sessionId: "047c62f6-607b-44db-bfbe-f83b67e9e8b1",
  models: {
    currentModelId: "gpt-oss-120b-medium",
    availableModels: [
      { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
      { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
      { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
      { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
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
      currentValue: "gpt-oss-120b-medium",
      options: [
        { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
        { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
        { value: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
        { value: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
        { value: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
        { value: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
  ],
} satisfies AcpSchema.NewSessionResponse;

// Protocol peer, not a live Google capture. Cold resume deliberately returns
// GPT-OSS so a saved Gemini selection must survive the absence of thinking_level.
export const antigravityThirdPartyAgentSource = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const setup = ${JSON.stringify(antigravityThirdPartySession)};
let sessionId = setup.sessionId;
let modelId = setup.models.currentModelId;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\r\\n");
const configOptions = () => {
  const gemini = modelId.startsWith("gemini-");
  const family = modelId.startsWith("gemini-3.8-flash-") ? "gemini-3.8-flash" : "gemini-4-argon";
  return [
    { ...setup.configOptions[0], currentValue: gemini ? family : modelId },
    ...(gemini ? [{
      id: "thinking_level", name: "Thinking Level", category: "thought_level", type: "select",
      currentValue: modelId.split("-").at(-1),
      options: ["low", "medium", "high"]
        .map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
    }] : []),
  ];
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, line + "\\n");
  if (request.id === undefined) continue;
  let result = {};
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.4.0" },
        agentCapabilities: { sessionCapabilities: { resume: {} } } };
      break;
    case "authenticate":
    case "session/set_mode":
      break;
    case "session/new":
    case "session/resume":
      sessionId = request.params.sessionId ?? sessionId;
      result = { ...setup, sessionId, configOptions: configOptions() };
      break;
    case "session/set_model":
      if (!setup.models.availableModels.some((model) => model.modelId === request.params.modelId)) {
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown model" } });
        continue;
      }
      modelId = request.params.modelId;
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: configOptions() } } });
      break;
    case "session/set_config_option":
      if (request.params.configId !== "mode") {
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Expected concrete model" } });
        continue;
      }
      result = { configOptions: configOptions() };
      break;
    case "session/prompt":
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text",
          text: process.env.T3_ACP_TITLE === "1" ? JSON.stringify({ title: modelId }) : modelId } } } });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
`;
