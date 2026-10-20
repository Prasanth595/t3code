import { describe, expect, it } from "vite-plus/test";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedChatLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillLinkRegex,
  pullRequestChipStates,
} from "./enrichedLinkPresentation";

describe("Enriched link presentation", () => {
  it("recognizes file-shaped code without turning commands or URLs into links", () => {
    for (const path of [
      "src/app.tsx",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\app.tsx",
      "app.tsx:12:3",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(path), path).toBe(true);
    }
    for (const text of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(text), text).toBe(false);
    }
  });

  it("only recognizes complete known skill names and escapes their punctuation", () => {
    const regex = enrichedSkillLinkRegex([{ name: "check" }, { name: "check.mobile" }]);
    expect(regex?.exec("Try $check.mobile next")?.[0]).toBe("$check.mobile");
    expect(regex?.exec("Try $check-mobile next")).toBeNull();
    expect(regex?.exec("Try $checkXmobile next")).toBeNull();
    expect(regex?.exec("prefix$check next")).toBeNull();
    expect(enrichedSkillLinkRegex([])).toBeNull();
  });

  it("matches only the complete URL, including literal regex metacharacters", () => {
    const url = "file:///workspace/app[1].tsx?line=3+4";
    const pattern = new RegExp(enrichedLinkVariantPattern(url));
    expect(pattern.test(url)).toBe(true);
    expect(pattern.test(`${url}/child`)).toBe(false);
    expect(pattern.test("file:///workspace/app1Xtsx?line=34")).toBe(false);
  });

  it("presents GitHub pull request URLs with the state their threads already know", () => {
    const states = new Map([["github.com/example/repo#7", { state: "open", isDraft: true }]]);
    expect(
      enrichedChatLinkPresentation("https://github.com/Example/Repo/pull/7/files", states),
    ).toEqual({
      accent: "#7f8793",
      icon: { kind: "chip", name: "git-pull-request-draft" },
      label: "#7",
    });
    expect(enrichedChatLinkPresentation("https://github.com/example/repo/pull/8", states)).toEqual({
      accent: "#7079e4",
      icon: { kind: "chip", name: "git-pull-request-arrow" },
      label: "#8",
    });
  });

  it("leaves other links alone", () => {
    for (const href of [
      "https://github.com/example/repo/issues/7",
      "https://gitlab.com/example/repo/-/merge_requests/7",
      "https://example.com/example/repo/pulls/7",
      "t3-context://v1/thread/thread_1",
    ]) {
      expect(enrichedChatLinkPresentation(href, new Map()), href).toBeUndefined();
    }
  });

  it("takes each pull request's state from its most recently synced link", () => {
    const link = (state: "open" | "merged", syncedAt: string): ThreadPullRequestLink => ({
      host: "github.com",
      repository: "Example/Repo",
      number: 7,
      url: "https://github.com/Example/Repo/pull/7",
      source: "manual",
      linkedAt: "2026-10-01T00:00:00.000Z",
      snapshot: {
        state,
        title: "Fix",
        headBranch: "fix",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt,
      },
      stack: null,
    });
    const stale = link("open", "2026-10-01T00:00:00.000Z");
    const fresh = link("merged", "2026-10-02T00:00:00.000Z");
    for (const links of [
      [stale, fresh],
      [fresh, stale],
    ]) {
      expect(
        enrichedChatLinkPresentation(
          "https://github.com/example/repo/pull/7",
          pullRequestChipStates(links),
        )?.icon,
      ).toEqual({ kind: "chip", name: "git-merge" });
    }
  });
});
