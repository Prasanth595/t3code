import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";
import { sanitizeCommitSubject, sanitizeThreadTitle } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeThreadTitle", () => {
  it("normalizes generated titles", () => {
    expect(sanitizeThreadTitle("  Implement issue #140  ")).toBe("Implement issue #140");
  });
});

describe("generateThreadTitle", () => {
  it.effect.each([
    { generated: "title", previousTitle: "Implement issue #140", expected: "Implement issue #140" },
    {
      generated: ' "TITLE" ',
      previousTitle: "  Implement issue #140  ",
      expected: "Implement issue #140",
    },
    { generated: "title", previousTitle: undefined, expected: "title" },
    { generated: "title", previousTitle: "", expected: "title" },
    {
      generated: "Improve title generation",
      previousTitle: "Old title",
      expected: "Improve title generation",
    },
  ])(
    "returns $expected for $generated with previous title $previousTitle",
    ({ generated, previousTitle, expected }) =>
      Effect.gen(function* () {
        const provider = fromRunner("test", (request) =>
          decodeJsonReply(
            request,
            "test",
            JSON.stringify({ title: generated, needsRefinement: true }),
          ),
        );
        const result = yield* provider.generateThreadTitle({
          cwd: "/repo",
          message: "Implement issue #140",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          previousTitle,
        });
        expect(result).toEqual({ title: expected, needsRefinement: true });
      }),
  );
});
