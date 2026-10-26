import { describe, expect, it } from "vite-plus/test";

import { nextDeliverableQueuedRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });

  it("characterizes delivery order with 1,000 completions behind one human message", () => {
    const completionIds = Array.from({ length: 1_000 }, (_, index) => `completion:${index}`);
    const projection = {
      messages: [
        { id: "message:human" },
        ...completionIds.map((id) => ({
          id: `message:${id}`,
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: [`task:${id}`],
          },
        })),
      ],
      runs: [
        {
          id: "run:human",
          ordinal: 1,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:human",
        },
        ...completionIds.map((id, index) => ({
          id: `run:${id}`,
          ordinal: index + 2,
          queuePosition: index + 2,
          status: "queued",
          userMessageId: `message:${id}`,
        })),
      ],
    } as never;

    const orderedRunIds = queuedRunsInDeliveryOrder(projection).map((run) => run.id);
    expect(orderedRunIds).toHaveLength(1_001);
    expect(orderedRunIds.slice(0, 1_000)).toEqual(completionIds.map((id) => `run:${id}`));
    expect(orderedRunIds[1_000]).toBe("run:human");
  });

  it("delivers verified human input before 1,000 internal completions in an enabled thread", () => {
    const completions = Array.from({ length: 1_000 }, (_, index) => index);
    const projection = {
      thread: { communicationLanesEnabled: true },
      messages: [
        {
          id: "message:human",
          communication: {
            classification: "verified",
            route: { port: "user.in" },
            producer: { kind: "human" },
          },
        },
        ...completions.map((index) => ({
          id: `message:internal:${index}`,
          delegatedCompletion: { taskIds: [`task:${index}`] },
          communication: {
            classification: "verified",
            route: { port: "internal.in" },
            producer: { kind: "server" },
          },
        })),
      ],
      runs: [
        ...completions.map((index) => ({
          id: `run:internal:${index}`,
          ordinal: index + 1,
          queuePosition: index + 1,
          status: "queued",
          userMessageId: `message:internal:${index}`,
        })),
        {
          id: "run:human",
          ordinal: 1_001,
          queuePosition: 1_001,
          status: "queued",
          userMessageId: "message:human",
        },
      ],
    } as never;

    const orderedRunIds = queuedRunsInDeliveryOrder(projection).map((run) => run.id);
    expect(orderedRunIds[0]).toBe("run:human");
    expect(orderedRunIds.slice(1)).toEqual(completions.map((index) => `run:internal:${index}`));
  });

  it("does not grant human priority to an agent claiming the user route", () => {
    const projection = {
      thread: { communicationLanesEnabled: true },
      messages: [
        {
          id: "message:forged",
          communication: {
            classification: "verified",
            route: { port: "user.in" },
            producer: { kind: "agent" },
          },
        },
        {
          id: "message:human",
          communication: {
            classification: "verified",
            route: { port: "user.in" },
            producer: { kind: "human" },
          },
        },
      ],
      runs: [
        { id: "run:forged", status: "queued", ordinal: 1, userMessageId: "message:forged" },
        { id: "run:human", status: "queued", ordinal: 2, userMessageId: "message:human" },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:human",
      "run:forged",
    ]);
  });

  it("pauses internal queued delivery without losing its run id and still serves human input", () => {
    const projection = {
      thread: { communicationLanesEnabled: true },
      messages: [
        {
          id: "message:internal",
          communication: {
            classification: "verified",
            route: { port: "internal.in" },
            producer: { kind: "agent" },
          },
        },
        {
          id: "message:human",
          communication: {
            classification: "verified",
            route: { port: "user.in" },
            producer: { kind: "human" },
          },
        },
      ],
      runs: [
        { id: "run:internal", status: "queued", ordinal: 1, userMessageId: "message:internal" },
        { id: "run:human", status: "queued", ordinal: 2, userMessageId: "message:human" },
      ],
    } as const;

    expect(nextDeliverableQueuedRun(projection as never, true)?.id).toBe("run:human");
    const afterHuman = { ...projection, runs: [projection.runs[0]] };
    expect(nextDeliverableQueuedRun(afterHuman as never, true)).toBeUndefined();
    expect(nextDeliverableQueuedRun(afterHuman as never, false)?.id).toBe("run:internal");
  });
});
