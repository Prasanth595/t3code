import { describe, expect, it } from "vite-plus/test";

import { buildPromptSuggestionPrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildPromptSuggestionPrompt", () => {
  it("keeps the newest reply and drops the oldest messages past the budget", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message-${index} ${"x".repeat(3_000)}`,
    }));
    const { prompt } = buildPromptSuggestionPrompt({ messages });

    expect(prompt).toContain("[Earlier content truncated]");
    expect(prompt).toContain("message-7");
    expect(prompt).not.toContain("message-0");
    expect(prompt.indexOf("message-6")).toBeLessThan(prompt.indexOf("message-7"));
  });
});
