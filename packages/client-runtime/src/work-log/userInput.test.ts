import { describe, expect, it } from "vite-plus/test";
import { ApprovalRequestId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
import { getQuestionAnswerHeading, getQuestionIds, getQuestionTextPreview } from "./userInput.ts";

function answer(
  overrides: Partial<UserInputAttachmentAnswerPayload> = {},
): UserInputAttachmentAnswerPayload {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    questionTextById: { scope: "Which repository?" },
    answers: { scope: "Use the private repository" },
    attachmentsByQuestionId: {},
    ...overrides,
  };
}

describe("getQuestionTextPreview", () => {
  it("joins the question texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which repository?", name: "What name?" } }),
      ),
    ).toBe("Which repository? · What name?");
  });

  it("normalizes whitespace and skips blank texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which\nrepository?", x: "  " } }),
      ),
    ).toBe("Which repository?");
  });

  it("returns an empty string without question texts", () => {
    expect(getQuestionTextPreview(answer({ questionTextById: undefined }))).toBe("");
  });
});

describe("getQuestionIds", () => {
  it("lists each question once, including ones answered only with attachments", () => {
    expect(
      getQuestionIds(
        answer({
          questionTextById: { scope: "Which repository?" },
          answers: { scope: "private", name: "t3" },
          attachmentsByQuestionId: { logo: [] },
        }),
      ),
    ).toEqual(["scope", "name", "logo"]);
  });
});

describe("getQuestionAnswerHeading", () => {
  it("leads with the question when only one was asked", () => {
    expect(getQuestionAnswerHeading(answer())).toBe("Which repository?");
  });

  it("counts several questions instead of joining them", () => {
    expect(
      getQuestionAnswerHeading(
        answer({
          questionTextById: { scope: "Which repository?", name: "What name?" },
          answers: { scope: "private", name: "t3" },
        }),
      ),
    ).toBe("Answered 2 questions");
  });
});
