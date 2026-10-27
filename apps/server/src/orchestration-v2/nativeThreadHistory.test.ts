import { expect, it } from "vite-plus/test";
import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import { itemIsInNativeThread, latestNativeCompactionRunOrdinal } from "./nativeThreadHistory.ts";

it("includes provider-generated compaction runs in the native history boundary", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:compaction-history");
  const otherProviderThreadId = ProviderThreadId.make("provider-thread:other-compaction");
  const explicitCompactMessageId = MessageId.make("message:explicit-compact");
  const runs = [
    {
      id: RunId.make("run:before-provider-compaction"),
      ordinal: 2,
      providerThreadId,
      userMessageId: MessageId.make("message:ordinary-1"),
    },
    {
      id: RunId.make("run:provider-compaction"),
      ordinal: 4,
      providerThreadId,
      userMessageId: MessageId.make("message:ordinary-2"),
    },
    {
      id: RunId.make("run:explicit-compaction"),
      ordinal: 6,
      providerThreadId,
      userMessageId: explicitCompactMessageId,
    },
    {
      id: RunId.make("run:other-compaction"),
      ordinal: 8,
      providerThreadId: otherProviderThreadId,
      userMessageId: MessageId.make("message:other-thread"),
    },
  ];

  expect(
    latestNativeCompactionRunOrdinal({
      runs,
      turnItems: [
        {
          type: "compaction",
          runId: runs[1]!.id,
          providerThreadId,
        },
        {
          type: "compaction",
          runId: runs[3]!.id,
          providerThreadId: otherProviderThreadId,
        },
      ],
      providerThreadId,
      compactionMessageIds: new Set([explicitCompactMessageId]),
    }),
  ).toBe(6);
});

it("only treats retained provider input as native transcript history", () => {
  const threadId = ThreadId.make("thread:native-history");
  const providerThreadId = ProviderThreadId.make("provider-thread:native-history");
  const beforeCompaction = RunId.make("run:before-compaction");
  const afterCompaction = RunId.make("run:after-compaction");
  const shared = {
    threadId,
    providerThreadId,
    acceptedRunIds: new Set([beforeCompaction, afterCompaction]),
    runOrdinals: new Map([
      [beforeCompaction, 1],
      [afterCompaction, 3],
    ]),
    latestCompactionRunOrdinal: 2,
  };

  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "user_message",
        threadId,
        providerThreadId,
        runId: beforeCompaction,
      },
    }),
  ).toBe(false);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "command_execution",
        threadId,
        providerThreadId,
        runId: afterCompaction,
        nativeItemRef: null,
      },
    }),
  ).toBe(false);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "command_execution",
        threadId,
        providerThreadId,
        runId: afterCompaction,
        nativeItemRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "command-1",
          strength: "strong",
        },
      },
    }),
  ).toBe(true);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "error",
        threadId,
        providerThreadId,
        runId: afterCompaction,
        nativeItemRef: null,
      },
    }),
  ).toBe(false);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "error",
        threadId,
        providerThreadId,
        runId: afterCompaction,
        nativeItemRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "error-1",
          strength: "strong",
        },
      },
    }),
  ).toBe(true);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "user_message",
        threadId,
        providerThreadId,
        runId: afterCompaction,
      },
    }),
  ).toBe(true);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        type: "run_interrupt_result",
        threadId,
        providerThreadId,
        runId: afterCompaction,
      },
    }),
  ).toBe(false);
  expect(
    itemIsInNativeThread({
      ...shared,
      item: {
        kind: "run_interrupt_result",
        threadId,
        providerThreadId,
        runId: afterCompaction,
      },
    }),
  ).toBe(false);
});
