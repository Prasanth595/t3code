import { describe, expect, it } from "@effect/vitest";
import {
  createTemporaryThreadView,
  forgetTemporaryThread,
  isTemporaryThread,
  setTemporaryThread,
} from "./temporaryThreads.ts";

describe("temporary view ownership", () => {
  it("replaces views on leave, keeps background ownership, and reconciles reconnects", () => {
    const view = createTemporaryThreadView({ viewId: "view", generation: 1 });
    expect(view.update({ environmentId: "one", threadIds: ["a"], background: false })).toEqual([
      {
        environmentId: "one",
        input: { viewId: "view", generation: 1, threadIds: ["a"], background: false },
      },
    ]);
    expect(
      view.update({ environmentId: "one", threadIds: ["a"], background: true })[0]?.input
        .background,
    ).toBe(true);
    expect(view.reconnect()[0]?.input).toEqual({
      viewId: "view",
      generation: 3,
      threadIds: ["a"],
      background: true,
    });
    expect(view.update({ environmentId: "two", threadIds: ["b"] })).toEqual([
      {
        environmentId: "two",
        input: { viewId: "view", generation: 4, threadIds: ["b"], background: false },
      },
      {
        environmentId: "one",
        input: { viewId: "view", generation: 4, threadIds: [], background: false },
      },
    ]);
    expect(view.update({ environmentId: "two", threadIds: [] })[0]?.input.threadIds).toEqual([]);
  });

  it("scopes volatile draft identity by environment and keeps it until durable Keep", () => {
    setTemporaryThread("one", "draft", true);
    expect(isTemporaryThread("one", "draft")).toBe(true);
    expect(isTemporaryThread("two", "draft")).toBe(false);
    setTemporaryThread("one", "draft", false);
    expect(isTemporaryThread("one", "draft")).toBe(false);
    forgetTemporaryThread("one", "draft");
  });
});

it("gives each changed view set a generation the server can accept", () => {
  const view = createTemporaryThreadView({ viewId: "ordered" });
  const opened = view.update({ environmentId: "one", threadIds: ["a"] });
  const background = view.update({ environmentId: "one", threadIds: ["a"], background: true });
  const closed = view.update({ environmentId: "one", threadIds: [] });
  expect(background[0]!.input.generation).toBeGreaterThan(opened[0]!.input.generation);
  expect(closed[0]!.input.generation).toBeGreaterThan(background[0]!.input.generation);
});
