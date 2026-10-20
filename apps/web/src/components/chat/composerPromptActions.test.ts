import { DEFAULT_COMPOSER_PROMPT_ACTIONS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  appendComposerPromptAction,
  composerPromptActionsAreDefault,
  runnableComposerPromptActions,
} from "./composerPromptActions";

describe("appendComposerPromptAction", () => {
  it("uses the action text as the whole prompt when the draft is empty", () => {
    expect(appendComposerPromptAction("  \n", "  Review this.  ")).toBe("Review this.");
  });

  it("adds the action as a new paragraph after the draft", () => {
    expect(appendComposerPromptAction("Fix the login bug.\n", "Review this.")).toBe(
      "Fix the login bug.\n\nReview this.",
    );
  });

  it("leaves the draft unchanged when the action was just added", () => {
    const once = appendComposerPromptAction("Fix the login bug.", "Review this.");

    expect(appendComposerPromptAction(`${once}\n`, "Review this.")).toBe(`${once}\n`);
  });
});

describe("runnableComposerPromptActions", () => {
  it("skips actions whose label or prompt is still blank", () => {
    const actions = [
      { id: "ready", label: "Review", prompt: "Review this." },
      { id: "no-label", label: " ", prompt: "Review this." },
      { id: "no-prompt", label: "Draft", prompt: "" },
    ];

    expect(runnableComposerPromptActions(actions).map((action) => action.id)).toEqual(["ready"]);
  });
});

describe("composerPromptActionsAreDefault", () => {
  it("treats an edited or removed default action as a change to reset", () => {
    const [review] = DEFAULT_COMPOSER_PROMPT_ACTIONS;

    expect(composerPromptActionsAreDefault([{ ...review! }])).toBe(true);
    expect(composerPromptActionsAreDefault([{ ...review!, label: "Review" }])).toBe(false);
    expect(composerPromptActionsAreDefault([])).toBe(false);
  });
});
