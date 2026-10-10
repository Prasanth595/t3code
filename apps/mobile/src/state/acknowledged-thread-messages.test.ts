import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { settledAcknowledgedMessageIds } from "./acknowledged-thread-messages";
import type { QueuedThreadMessage } from "./thread-outbox-model";

function acknowledged(id: string, createdAt: string): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(id),
    commandId: CommandId.make(`command-${id}`),
    text: id,
    attachments: [],
    createdAt,
  };
}

function loaded(id: string, createdAt: string) {
  return { id, createdAtMs: Date.parse(createdAt) };
}

describe("settledAcknowledgedMessageIds", () => {
  it("settles a message once the server echo is loaded", () => {
    expect(
      settledAcknowledgedMessageIds({
        acknowledged: [acknowledged("echoed", "2026-10-10T15:01:24.657Z")],
        loadedMessages: [loaded("echoed", "2026-10-10T15:01:24.657Z")],
        hasMoreHistory: false,
      }),
    ).toEqual(new Set(["echoed"]));
  });

  it("settles a message older than a bounded history's first loaded message", () => {
    // A busy thread reopened after many turns loads only its newest window, so
    // the echo of a message sent earlier is in unloaded history.
    expect(
      settledAcknowledgedMessageIds({
        acknowledged: [acknowledged("paged-out", "2026-10-10T15:01:24.657Z")],
        loadedMessages: [
          loaded("newer-1", "2026-10-10T21:40:00.000Z"),
          loaded("newer-2", "2026-10-10T22:16:46.296Z"),
        ],
        hasMoreHistory: true,
      }),
    ).toEqual(new Set(["paged-out"]));
  });

  it("keeps a message whose echo has not reached a fully loaded thread", () => {
    expect(
      settledAcknowledgedMessageIds({
        acknowledged: [acknowledged("in-flight", "2026-10-10T15:01:24.657Z")],
        loadedMessages: [loaded("newer", "2026-10-10T21:40:00.000Z")],
        hasMoreHistory: false,
      }),
    ).toEqual(new Set());
  });

  it("keeps a message inside the loaded window until its echo arrives", () => {
    expect(
      settledAcknowledgedMessageIds({
        acknowledged: [acknowledged("in-flight", "2026-10-10T22:20:00.000Z")],
        loadedMessages: [loaded("older", "2026-10-10T21:40:00.000Z")],
        hasMoreHistory: true,
      }),
    ).toEqual(new Set());
  });
});
