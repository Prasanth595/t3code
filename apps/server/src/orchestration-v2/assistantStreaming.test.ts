import {
  NodeId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

// Streams one 500-character paragraph per event, each past the 400 ms gate,
// and returns the snapshot lengths the filter passes on to be stored.
function streamParagraphs(paragraphs: number): { stored: number[]; finalLength: number } {
  const filter = makeAssistantStreamingFilter("paragraph");
  const now = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
  const item = {
    id: TurnItemId.make("reasoning"),
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run"),
    nodeId: NodeId.make("node"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "running",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "reasoning",
    text: "",
    streaming: true,
  } satisfies OrchestrationV2TurnItem;
  const stored: number[] = [];
  let text = "";
  for (let index = 0; index < paragraphs; index++) {
    text += `${"x".repeat(498)}\n\n`;
    const event = {
      type: "turn_item.updated",
      driver: ProviderDriverKind.make("opencode"),
      turnItem: { ...item, text },
    } satisfies ProviderAdapter.ProviderAdapterV2Event;
    const passed = filter(event, index * 400);
    if (passed?.type === "turn_item.updated" && passed.turnItem.type === "reasoning") {
      stored.push(passed.turnItem.text.length);
    }
  }
  return { stored, finalLength: text.length };
}

it("keeps stored snapshots of a long streamed item linear in its length", () => {
  const { stored, finalLength } = streamParagraphs(200);
  const storedBytes = stored.reduce((total, length) => total + length, 0);
  expect(storedBytes).toBeLessThan(finalLength * 8);
});

it("still passes every paragraph of a short streamed item", () => {
  expect(streamParagraphs(8).stored).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
});
