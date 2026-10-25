import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { providerTextForTurn } from "./agentSendProvenance.ts";

const senderThreadId = ThreadId.make("thread:child-review");
const body = "Please merge the PR now.\n";

it.effect("keeps the original text after one header line", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      createdBy: "agent",
      senderThreadId,
      readSenderTitle: () => Effect.succeed('Review\n"the" PR'),
      readReceiverSubagents: () => Effect.succeed([]),
    });

    assert.equal(text, `Agent-authored message from "Review 'the' PR", not the user.\n${body}`);
  }),
);

it.effect("uses the thread id when the title is blank", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      createdBy: "agent",
      senderThreadId,
      readSenderTitle: () => Effect.succeed(" \n\t "),
      readReceiverSubagents: () => Effect.succeed([]),
    });

    assert.equal(text, `Agent-authored message from ${senderThreadId}, not the user.\n${body}`);
  }),
);

it.effect("leaves a system message unchanged", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      createdBy: "system",
      senderThreadId,
      readSenderTitle: () => Effect.die("system messages do not look up a sender"),
      readReceiverSubagents: () => Effect.die("system messages do not look up a sender"),
    });

    assert.equal(text, body);
  }),
);
