import { describe, expect, it } from "vite-plus/test";
import {
  SIDE_QUESTION_COMMAND,
  parseSideQuestionCommand,
  sideQuestionForkDraft,
} from "./sideQuestion.ts";

describe("parseSideQuestionCommand", () => {
  it("returns the question after the command", () => {
    expect(parseSideQuestionCommand("/btw what does this function do?")).toBe(
      "what does this function do?",
    );
  });

  it("keeps multi-line questions and trims the edges", () => {
    expect(parseSideQuestionCommand("/btw  first line\nsecond line  ")).toBe(
      "first line\nsecond line",
    );
  });

  it("is case-insensitive", () => {
    expect(parseSideQuestionCommand("/BTW why?")).toBe("why?");
  });

  it("recognizes a bare command so sending it opens the panel", () => {
    expect(parseSideQuestionCommand("/btw")).toBe("");
    expect(parseSideQuestionCommand("/btw   ")).toBe("");
  });

  it("leaves ordinary prompts and other commands alone", () => {
    expect(parseSideQuestionCommand("what does /btw do?")).toBeNull();
    expect(parseSideQuestionCommand("/btwx why?")).toBeNull();
    expect(parseSideQuestionCommand("/compact")).toBeNull();
  });

  it("advertises a name the client and server both match on", () => {
    expect(SIDE_QUESTION_COMMAND.name).toBe("btw");
  });
});

describe("sideQuestionForkDraft", () => {
  it("quotes every exchange, keeping blank answer lines inside the quote", () => {
    expect(
      sideQuestionForkDraft([
        {
          question: " Where is the parser?\nAnd its tests? ",
          answer: "In parser.ts.\n\nIts tests are next to it.",
        },
        { question: "Is it slow?", answer: "No." },
      ]),
    ).toBe(
      [
        "From a side question:",
        "",
        "> **Q:** Where is the parser?",
        "> And its tests?",
        ">",
        "> In parser.ts.",
        ">",
        "> Its tests are next to it.",
        "",
        "> **Q:** Is it slow?",
        ">",
        "> No.",
        "",
        "",
      ].join("\n"),
    );
  });
});
