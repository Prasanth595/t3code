import { describe, expect, it } from "vite-plus/test";

import { buildNextPromptPrompt } from "./textGenerationPrompts.ts";
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

describe("buildNextPromptPrompt", () => {
  it("appends the user's instructions and the conversation", () => {
    const { prompt } = buildNextPromptPrompt({
      message: "USER:\nFix the build\n\nASSISTANT:\nDone.",
      instructions: "Always answer in Polish.",
    });

    expect(prompt).toContain("Additional instructions:\nAlways answer in Polish.");
    expect(prompt.endsWith("Conversation:\nUSER:\nFix the build\n\nASSISTANT:\nDone.")).toBe(true);
  });

  it("omits the instructions section when none are set", () => {
    const { prompt } = buildNextPromptPrompt({ message: "USER:\nHi", instructions: "  " });

    expect(prompt).not.toContain("Additional instructions:");
  });

  it("keeps the end of an oversized conversation, where the next step is decided", () => {
    const { prompt } = buildNextPromptPrompt({ message: `${"a".repeat(20_000)}THE-END` });

    expect(prompt.endsWith("THE-END")).toBe(true);
    expect(prompt).toContain("[Earlier content truncated]");
  });
});
