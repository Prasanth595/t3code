import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentComposerGoalBar } from "./presentComposerGoalBar";

function goal(
  status: OrchestrationV2ProviderGoal["status"],
  objective = "All tests in packages/api pass",
): OrchestrationV2ProviderGoal {
  return { objective, status };
}

function present(
  status: OrchestrationV2ProviderGoal["status"],
  prompt: string,
  options?: { readonly working?: boolean; readonly canPauseResume?: boolean },
) {
  return presentComposerGoalBar({
    goal: goal(status),
    working: options?.working ?? false,
    prompt,
    canPauseResume: options?.canPauseResume ?? true,
  });
}

describe("presentComposerGoalBar", () => {
  it("hides a missing or finished goal", () => {
    expect(
      presentComposerGoalBar({ goal: null, working: false, prompt: "", canPauseResume: true }),
    ).toBeNull();
    expect(present("complete", "")).toBeNull();
  });

  it("shows the current goal above the composer", () => {
    expect(present("paused", "")).toMatchObject({
      title: "Goal paused",
      objective: "All tests in packages/api pass",
      playback: "play",
      emphasizing: null,
    });
    expect(present("active", "next", { working: true })).toMatchObject({
      title: "Pursuing goal",
      playback: "pause",
      emphasizing: null,
    });
  });

  it("names the goal a /goal resume draft will continue", () => {
    expect(present("paused", "  /goal resume  ")).toMatchObject({
      title: "Resuming goal",
      objective: "All tests in packages/api pass",
      playback: "play",
      emphasizing: "resume",
    });
  });

  it("keeps pause and play for any way the goal was started", () => {
    expect(present("active", "/goal ship the fix")?.playback).toBe("pause");
    expect(present("active", "")?.playback).toBe("pause");
    expect(present("paused", "/goal resume")?.playback).toBe("play");
    expect(present("paused", "/goal all tests pass")?.playback).toBe("play");
    expect(present("usage_limited", "")?.playback).toBe("play");
    expect(present("active", "", { canPauseResume: false })?.playback).toBeNull();
    expect(present("paused", "", { working: true })?.playback).toBeNull();
    expect(present("active", "", { working: true })?.playback).toBe("pause");
  });

  it("names pause, clear, and a replacement the same way", () => {
    expect(present("active", "/goal pause", { working: true })?.title).toBe("Pausing goal");
    expect(present("active", "/goal clear")?.emphasizing).toBe("clear");
    expect(present("active", "/goal ship the fix")).toMatchObject({
      title: "Replacing goal",
      objective: "All tests in packages/api pass",
      playback: "pause",
      emphasizing: "replace",
    });
  });

  it("ignores a /goal command that is only part of a message", () => {
    expect(present("paused", "please /goal resume")?.title).toBe("Goal paused");
  });

  it("does not advertise pause or resume for a provider that rejects them", () => {
    expect(present("active", "/goal pause", { canPauseResume: false })?.title).toBe("Goal set");
    expect(present("paused", "/goal resume", { canPauseResume: false })).toMatchObject({
      title: "Goal paused",
      emphasizing: null,
      playback: null,
    });
  });

  it("ignores a goal command when the draft has an attachment", () => {
    expect(
      presentComposerGoalBar({
        goal: goal("active"),
        working: false,
        prompt: "/goal clear",
        canPauseResume: true,
        hasAttachments: true,
      }),
    ).toMatchObject({ title: "Goal set", emphasizing: null });
  });
});
