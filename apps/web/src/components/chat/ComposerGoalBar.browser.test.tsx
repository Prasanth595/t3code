import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerGoalBar } from "./ComposerGoalBar";
import { presentComposerGoalBar } from "./presentComposerGoalBar";

function modelFor(status: "active" | "paused", prompt: string) {
  const model = presentComposerGoalBar({
    goal: { objective: "All tests in packages/api pass", status },
    working: status === "active",
    prompt,
    canPauseResume: true,
  });
  if (model === null) throw new Error("expected a goal bar");
  return model;
}

it("shows the goal a /goal resume draft continues, with play", async () => {
  await using screen = await render(
    <ComposerGoalBar
      model={modelFor("paused", "/goal resume")}
      canOperate
      onSendCommand={() => Promise.resolve()}
    />,
  );

  expect(screen.getByRole("status").element().textContent).toContain("Resuming goal");
  expect(screen.getByRole("status").element().textContent).toContain(
    "All tests in packages/api pass",
  );
  expect(screen.getByRole("button", { name: "Resume goal" }).element()).toBeTruthy();
});

it("pauses an active goal from the bar, including one set with an objective", async () => {
  const onSendCommand = vi.fn(() => Promise.resolve());
  await using screen = await render(
    <ComposerGoalBar
      model={modelFor("active", "/goal ship the fix")}
      canOperate
      onSendCommand={onSendCommand}
    />,
  );

  await screen.getByRole("button", { name: "Pause goal" }).click();
  expect(onSendCommand).toHaveBeenCalledWith("/goal pause", "Failed to pause goal.");
});

it("resumes a paused goal from the play control", async () => {
  const onSendCommand = vi.fn(() => Promise.resolve());
  await using screen = await render(
    <ComposerGoalBar model={modelFor("paused", "")} canOperate onSendCommand={onSendCommand} />,
  );

  await screen.getByRole("button", { name: "Resume goal" }).click();
  expect(onSendCommand).toHaveBeenCalledWith("/goal resume", "Failed to resume goal.");
});
