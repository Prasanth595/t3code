import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  clientSupportsCommunicationLanes,
  communicationClientThreadNeedsUpgrade,
  communicationMutationThreadIds,
  requiresCommunicationLanesUpgrade,
} from "./CommunicationClientCompatibility.ts";

const threadId = ThreadId.make("thread:lanes");

describe("communication-lanes client compatibility", () => {
  it("requires an explicit capability on the WebSocket URL", () => {
    expect(clientSupportsCommunicationLanes(new URL("ws://localhost/ws"))).toBe(false);
    expect(
      clientSupportsCommunicationLanes(new URL("ws://localhost/ws?communicationLanesClient=0")),
    ).toBe(false);
    expect(
      clientSupportsCommunicationLanes(new URL("ws://localhost/ws?communicationLanesClient=1")),
    ).toBe(true);
  });

  it("keeps old connections read-only in enabled threads", () => {
    expect(requiresCommunicationLanesUpgrade({ communicationLanesEnabled: true }, false)).toBe(
      true,
    );
    expect(requiresCommunicationLanesUpgrade({ communicationLanesEnabled: true }, true)).toBe(
      false,
    );
    expect(requiresCommunicationLanesUpgrade({ communicationLanesEnabled: false }, false)).toBe(
      false,
    );
  });

  it.effect(
    "blocks old sockets from lazy internal detail but keeps it available to current sockets",
    () =>
      Effect.gen(function* () {
        const reads: string[] = [];
        const readThread = (id: ThreadId) =>
          Effect.sync(() => {
            reads.push(id);
            return { communicationLanesEnabled: true };
          });
        expect(yield* communicationClientThreadNeedsUpgrade(false, [threadId], readThread)).toBe(
          true,
        );
        expect(reads).toEqual([threadId]);
        expect(yield* communicationClientThreadNeedsUpgrade(true, [threadId], readThread)).toBe(
          false,
        );
        expect(reads).toEqual([threadId]);
      }),
  );

  it("checks the existing thread behind sends and queue controls", () => {
    for (const command of [
      {
        type: "message.dispatch",
        messageId: MessageId.make("message:1"),
        text: "hi",
        attachments: [],
      },
      { type: "queue.resume" },
      { type: "queued-run.reorder", runId: "run:1", beforeRunId: null },
      { type: "queued-run.edit", runId: "run:1", text: "edit" },
      { type: "thread.model-selection.set", modelSelection: {} },
    ]) {
      expect(
        communicationMutationThreadIds({
          ...command,
          commandId: CommandId.make("command:1"),
          threadId,
        } as never),
      ).toEqual([threadId]);
    }
  });
});
