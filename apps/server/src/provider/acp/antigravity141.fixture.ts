import type * as AcpSchema from "effect-acp/compat";

// Captured from the unwrapped Linux ACP 1.4.1 binary, 2026-10-26.
// Isolated GEMINI_HOME, gemini-api-key mode with an invalid placeholder key;
// session setup only, no prompt or account entitlement claim.
export const antigravity141Initialize = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: {
      image: true,
      audio: true,
      embeddedContext: true,
    },
    mcpCapabilities: {
      http: true,
      sse: true,
    },
    sessionCapabilities: {
      list: {},
      resume: {},
    },
    auth: {
      logout: {},
    },
    _meta: {
      antigravity: {
        tier: true,
        systemPrompt: {
          append: true,
        },
      },
    },
  },
  authMethods: [
    {
      id: "oauth-personal",
      name: "Log in with Google",
      description: "Log in with your Google account",
    },
    {
      id: "oauth-business",
      name: "Log in with Gemini Enterprise",
      description: "Log in with your Gemini Enterprise account",
    },
    {
      id: "gemini-api-key",
      name: "Gemini API key",
      description: "Use an API key with Gemini Developer API",
    },
    {
      id: "agent-platform",
      name: "Gemini Enterprise Agent Platform",
      description:
        "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials or an API key",
    },
  ],
  agentInfo: {
    name: "antigravity-acp",
    title: "Google Antigravity",
    version: "1.4.1",
  },
} satisfies AcpSchema.InitializeResponse;

export const antigravity141Session = {
  sessionId: "b5e01d27-0312-4417-9f2c-0523dccb7b1a",
  modes: {
    currentModeId: "default",
    availableModes: [
      {
        id: "default",
        name: "Default",
        description: "Default permission prompt flow",
      },
      {
        id: "auto_edit",
        name: "Auto Edit",
        description: "Auto-approve file edit tools",
      },
      {
        id: "yolo",
        name: "YOLO",
        description: "Auto-approve all tools",
      },
    ],
  },
  configOptions: [
    {
      currentValue: "gemini-3.8-flash",
      options: [
        {
          value: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
        },
        {
          value: "gemini-3.7-flash",
          name: "Gemini 3.7 Flash",
        },
        {
          value: "gemini-3.6-flash",
          name: "Gemini 3.6 Flash",
        },
        {
          value: "gemini-3.5-flash",
          name: "Gemini 3.5 Flash",
        },
        {
          value: "gemini-3.1-pro",
          name: "Gemini 3.1 Pro",
        },
      ],
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
    },
    {
      currentValue: "high",
      options: [
        {
          value: "low",
          name: "Low",
        },
        {
          value: "medium",
          name: "Medium",
        },
        {
          value: "high",
          name: "High",
        },
      ],
      id: "thinking_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
    },
    {
      currentValue: "default",
      options: [
        {
          value: "default",
          name: "Default",
          description: "Default permission prompt flow",
        },
        {
          value: "auto_edit",
          name: "Auto Edit",
          description: "Auto-approve file edit tools",
        },
        {
          value: "yolo",
          name: "YOLO",
          description: "Auto-approve all tools",
        },
      ],
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
    },
  ],
  models: {
    availableModels: [
      {
        modelId: "gemini-3.8-flash-high",
        name: "Gemini 3.8 Flash (High)",
        description: "Gemini 3.8 Flash model with high thinking level",
      },
      {
        modelId: "gemini-3.8-flash-medium",
        name: "Gemini 3.8 Flash (Medium)",
        description: "Gemini 3.8 Flash model with medium thinking level",
      },
      {
        modelId: "gemini-3.8-flash-low",
        name: "Gemini 3.8 Flash (Low)",
        description: "Gemini 3.8 Flash model with low thinking level",
      },
      {
        modelId: "gemini-3.7-flash-high",
        name: "Gemini 3.7 Flash (High)",
        description: "Gemini 3.7 Flash model with high thinking level",
      },
      {
        modelId: "gemini-3.7-flash-medium",
        name: "Gemini 3.7 Flash (Medium)",
        description: "Gemini 3.7 Flash model with medium thinking level",
      },
      {
        modelId: "gemini-3.7-flash-low",
        name: "Gemini 3.7 Flash (Low)",
        description: "Gemini 3.7 Flash model with low thinking level",
      },
      {
        modelId: "gemini-3.6-flash-high",
        name: "Gemini 3.6 Flash (High)",
        description: "Gemini 3.6 Flash model with high thinking level",
      },
      {
        modelId: "gemini-3.6-flash-medium",
        name: "Gemini 3.6 Flash (Medium)",
        description: "Gemini 3.6 Flash model with medium thinking level",
      },
      {
        modelId: "gemini-3.6-flash-low",
        name: "Gemini 3.6 Flash (Low)",
        description: "Gemini 3.6 Flash model with low thinking level",
      },
      {
        modelId: "gemini-3.5-flash-high",
        name: "Gemini 3.5 Flash (High)",
        description: "Gemini 3.5 Flash model with high thinking level",
      },
      {
        modelId: "gemini-3.5-flash-medium",
        name: "Gemini 3.5 Flash (Medium)",
        description: "Gemini 3.5 Flash model with medium thinking level",
      },
      {
        modelId: "gemini-3.5-flash-low",
        name: "Gemini 3.5 Flash (Low)",
        description: "Gemini 3.5 Flash model with low thinking level",
      },
      {
        modelId: "gemini-3.1-pro-high",
        name: "Gemini 3.1 Pro (High)",
        description: "Gemini 3.1 Pro model with high thinking level",
      },
      {
        modelId: "gemini-3.1-pro-low",
        name: "Gemini 3.1 Pro (Low)",
        description: "Gemini 3.1 Pro model with low thinking level",
      },
    ],
    currentModelId: "gemini-3.8-flash-high",
  },
} satisfies AcpSchema.NewSessionResponse;

// Native response after session/set_model selected gemini-3.1-pro-low,
// followed by session/set_config_option(thinking_level, low).
export const antigravity141ConfigResponse = {
  configOptions: [
    {
      currentValue: "gemini-3.1-pro",
      options: [
        {
          value: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
        },
        {
          value: "gemini-3.7-flash",
          name: "Gemini 3.7 Flash",
        },
        {
          value: "gemini-3.6-flash",
          name: "Gemini 3.6 Flash",
        },
        {
          value: "gemini-3.5-flash",
          name: "Gemini 3.5 Flash",
        },
        {
          value: "gemini-3.1-pro",
          name: "Gemini 3.1 Pro",
        },
      ],
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
    },
    {
      currentValue: "low",
      options: [
        {
          value: "low",
          name: "Low",
        },
        {
          value: "high",
          name: "High",
        },
      ],
      id: "thinking_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
    },
    {
      currentValue: "default",
      options: [
        {
          value: "default",
          name: "Default",
          description: "Default permission prompt flow",
        },
        {
          value: "auto_edit",
          name: "Auto Edit",
          description: "Auto-approve file edit tools",
        },
        {
          value: "yolo",
          name: "YOLO",
          description: "Auto-approve all tools",
        },
      ],
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
    },
  ],
} satisfies AcpSchema.SetSessionConfigOptionResponse;
