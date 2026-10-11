import { describe, expect, it } from "vite-plus/test";

import { MODEL_FAMILY_LABEL, MODEL_FAMILY_ORDER, modelFamily } from "./usageModelFamily.ts";

describe("modelFamily", () => {
  it.each([
    ["claude-opus-5-5", "anthropic"],
    ["gpt-6-1-sol", "openai"],
    ["gemini-4-argon", "google"],
    ["grok-4.7", "xai"],
    ["composer-1", "cursor"],
    ["muse-spark-1-3", "meta"],
    ["kimi-k3", "moonshot"],
    ["glm-5-3-flash", "zai"],
    ["deepseek-v4-pro", "deepseek"],
    ["mimo-v2-6-pro", "xiaomi"],
    ["qwen3-coder", "alibaba"],
    ["codestral-latest", "mistral"],
    ["o3", "openai"],
    ["o4-mini", "openai"],
  ] as const)("classifies the public model id %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it.each([
    ["sonnet", "anthropic"],
    ["haiku-5", "anthropic"],
    ["claude-fable-5", "anthropic"],
    ["gpt-5.3-codex", "openai"],
    ["codex-mini-latest", "openai"],
    ["gemma-4-27b", "google"],
    ["llama-5-70b", "meta"],
    ["qwq-32b", "alibaba"],
    ["mixtral-8x22b", "mistral"],
    ["devstral-medium", "mistral"],
    ["magistral-small", "mistral"],
    ["mistral-large-3", "mistral"],
    ["ministral-8b", "mistral"],
    ["pixtral-large", "mistral"],
  ] as const)("matches the family token in %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it.each([
    ["qwen3", "alibaba"],
    ["gpt4o", "openai"],
    ["glm4", "zai"],
    ["llama3", "meta"],
    ["o3", "openai"],
  ] as const)("accepts a version digit right after the token in %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it.each(["museum-7b", "mimosa", "glmatrix", "codextra"])(
    "does not match a token that merely starts the word %s",
    (model) => {
      expect(modelFamily(model)).toBe("unknown");
    },
  );

  it("picks the family whose token appears first in the id", () => {
    expect(modelFamily("deepseek-r1-distill-llama-70b")).toBe("deepseek");
    expect(modelFamily("llama-3-gpt-distill")).toBe("meta");
  });

  it("ignores case, bracket variants and region prefixes", () => {
    expect(modelFamily("Claude-Opus-5-5[1m]")).toBe("anthropic");
    expect(modelFamily("global.anthropic.claude-sonnet-5")).toBe("anthropic");
    expect(modelFamily("us.meta.llama-5-70b")).toBe("meta");
    expect(modelFamily("eu.mistral.mistral-large-3")).toBe("mistral");
  });

  it("lets a vendor path segment beat the family tokens", () => {
    expect(modelFamily("relay/openai/gpt-oss-120b")).toBe("openai");
    expect(modelFamily("openai.gpt-5.5")).toBe("openai");
    expect(modelFamily("gateway/moonshotai/kimi-k3")).toBe("moonshot");
    expect(modelFamily("relay/anthropic/gpt-in-name")).toBe("anthropic");
    expect(modelFamily("router/google/gemma-4")).toBe("google");
    expect(modelFamily("router/meta-llama/llama-5-70b")).toBe("meta");
    expect(modelFamily("router/z-ai/glm-5")).toBe("zai");
    expect(modelFamily("router/zai-org/glm-5")).toBe("zai");
    expect(modelFamily("router/deepseek-ai/deepseek-v4")).toBe("deepseek");
    expect(modelFamily("router/qwen/qwen3-max")).toBe("alibaba");
    expect(modelFamily("router/mistralai/codestral-latest")).toBe("mistral");
    expect(modelFamily("router/x-ai/grok-5")).toBe("xai");
    expect(modelFamily("router/xai/grok-5")).toBe("xai");
  });

  it("resolves dash-joined vendor prefixes through the family token", () => {
    expect(modelFamily("acme-openai-gpt-6")).toBe("openai");
    expect(modelFamily("claude-opus-4-6-via-proxy")).toBe("anthropic");
  });

  it("reads Pi's provider-prefixed labels", () => {
    expect(modelFamily("anthropic/claude-opus-5-5")).toBe("anthropic");
    expect(modelFamily("openai-codex/gpt-6-1-sol")).toBe("openai");
    expect(modelFamily("github-copilot/claude-sonnet-5")).toBe("anthropic");
    // Pi's tool and summary calls carry no model.
    expect(modelFamily("Tools/summaries")).toBe("unknown");
  });

  it("only matches tokens at a word boundary", () => {
    // `foo3` contains `o3` but not as a word, and `glamour` contains no family.
    expect(modelFamily("foo3")).toBe("unknown");
    expect(modelFamily("acmegpt-1")).toBe("unknown");
    expect(modelFamily("big-pickle")).toBe("unknown");
    expect(modelFamily("o3x")).toBe("unknown");
  });

  it("leaves unrecognized and placeholder models unknown", () => {
    expect(modelFamily("<synthetic>")).toBe("unknown");
    expect(modelFamily("")).toBe("unknown");
    expect(modelFamily("my-local-model")).toBe("unknown");
  });

  it("labels every family once, ending with the unknown bucket", () => {
    expect(MODEL_FAMILY_ORDER.at(-1)).toBe("unknown");
    expect(new Set(MODEL_FAMILY_ORDER).size).toBe(MODEL_FAMILY_ORDER.length);
    expect(MODEL_FAMILY_ORDER.map((family) => MODEL_FAMILY_LABEL[family])).toEqual([
      "Anthropic",
      "OpenAI",
      "Google",
      "xAI",
      "Cursor",
      "Meta",
      "Moonshot (Kimi)",
      "Z.ai (GLM)",
      "DeepSeek",
      "Xiaomi (MiMo)",
      "Alibaba (Qwen)",
      "Mistral",
      "Other / unknown",
    ]);
  });
});
