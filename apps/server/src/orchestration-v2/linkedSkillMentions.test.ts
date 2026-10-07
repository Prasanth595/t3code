import { describe, expect, it } from "vite-plus/test";

import { expandLinkedSkillMentions } from "./linkedSkillMentions.ts";

const projectReview = "/repo/.claude/skills/review/SKILL.md";

describe("expandLinkedSkillMentions", () => {
  it("replaces a linked mention with the name and points at the picked file", () => {
    expect(expandLinkedSkillMentions(`Run [$review](${projectReview}) on this diff`)).toBe(
      `Run review on this diff\n\nThe user invoked the \`review\` skill defined in ${projectReview}. Read that file and follow its instructions, not those of any other skill named \`review\`.`,
    );
  });

  it("names each picked file once, including a mention that ends the prompt", () => {
    const expanded = expandLinkedSkillMentions(
      `[$review](${projectReview}) first, then [$review](${projectReview})`,
    );
    expect(expanded.startsWith("review first, then review\n\n")).toBe(true);
    expect(expanded.split(projectReview)).toHaveLength(2);
  });

  it("leaves plain mentions for the provider's native dispatch", () => {
    expect(expandLinkedSkillMentions("Run $review on this diff")).toBe("Run $review on this diff");
  });
});
