import { describe, expect, it } from "vite-plus/test";
import {
  FALLBACK_ANTIGRAVITY_CLI_MODELS,
  parseAntigravityCliModelsOutput,
} from "./AntigravityCliModels.ts";
import { ANTIGRAVITY_DEFAULT_MODEL } from "@t3tools/contracts";

describe("parseAntigravityCliModelsOutput", () => {
  it("parses tab-separated models output from agy models", () => {
    const raw = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;
    const models = parseAntigravityCliModelsOutput(raw);
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      slug: "gemini-3.8-flash-high",
      name: "Gemini 3.8 Flash (High)",
      isDefault: true,
      aliases: [ANTIGRAVITY_DEFAULT_MODEL],
    });
    expect(models[1]).toMatchObject({
      slug: "gemini-3.8-flash-medium",
      name: "Gemini 3.8 Flash (Medium)",
    });
    expect(models[2]).toMatchObject({
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6 (Thinking)",
    });
  });

  it("falls back to standard models when output is empty or only header", () => {
    const raw = "Fetching available models...\n";
    const models = parseAntigravityCliModelsOutput(raw);
    expect(models.length).toBe(FALLBACK_ANTIGRAVITY_CLI_MODELS.length);
    expect(models[0]?.aliases).toEqual([ANTIGRAVITY_DEFAULT_MODEL]);
  });

  it("deduplicates model slugs", () => {
    const raw = `gemini-3.8-flash-high\tGemini 3.8 Flash
gemini-3.8-flash-high\tGemini 3.8 Flash Duplicate
`;
    const models = parseAntigravityCliModelsOutput(raw);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("Gemini 3.8 Flash");
  });
});
