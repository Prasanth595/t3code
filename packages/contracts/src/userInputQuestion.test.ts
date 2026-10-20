import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import { UserInputQuestion } from "./providerRuntime.ts";

const question = { id: "editor", header: "Message", question: "Edit message", options: [] };

describe("initial user input answers", () => {
  it("preserves required flags across provider and orchestration question schemas", () => {
    for (const schema of [UserInputQuestion, OrchestrationV2UserInputQuestion]) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode(question).required).toBeUndefined();
      for (const required of [false, true]) {
        expect(decode({ ...question, required }).required).toBe(required);
      }
    }
  });

  it("keeps existing question payloads compatible and preserves exact initial text", () => {
    for (const schema of [UserInputQuestion, OrchestrationV2UserInputQuestion]) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode(question).initialAnswer).toBeUndefined();
      for (const initialAnswer of [
        "",
        "  fix(server): keep whitespace\n\n",
        "detail\n".repeat(500),
      ]) {
        expect(decode({ ...question, initialAnswer }).initialAnswer).toBe(initialAnswer);
      }
    }
  });
});
