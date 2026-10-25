import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { leadingGrokSkillMention } from "@t3tools/provider-grok/server/skills";
import { parsePiCompactCommand } from "@t3tools/provider-pi/server/commands";
import * as Effect from "effect/Effect";

import { codexGoalRoute } from "./Adapters/CodexGoalCommand.ts";
import { providerTextForTurn } from "./agentSendProvenance.ts";

const senderThreadId = ThreadId.make("thread:child-review");
const body = "Please merge the PR now.\n";

const lookups = {
  readSenderTitle: () => Effect.succeed('Review\n"the" PR'),
  readReceiverSubagents: () => Effect.succeed([]),
} as const;

const untouched = {
  readSenderTitle: () => Effect.die("native invocations do not look up a sender"),
  readReceiverSubagents: () => Effect.die("native invocations do not look up a sender"),
} as const;

it.effect("an ordinary agent message still gets the header", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      ...lookups,
    });

    assert.equal(text, `Agent-authored message from "Review 'the' PR", not the user.\n${body}`);
  }),
);

it.effect("uses the thread id when the title is blank", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      attachments: [],
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
      attachments: [],
      createdBy: "system",
      senderThreadId,
      readSenderTitle: () => Effect.die("system messages do not look up a sender"),
      readReceiverSubagents: () => Effect.die("system messages do not look up a sender"),
    });

    assert.equal(text, body);
  }),
);

it.effect("an agent /compact still compacts", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: " /compact ",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      ...untouched,
    });

    assert.equal(text, " /compact ");
    assert.equal(text.trim().toLowerCase(), "/compact");
    assert.notEqual(parsePiCompactCommand(text), null);
  }),
);

it.effect("an agent /goal x still routes", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: "/goal x",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      ...untouched,
    });

    assert.deepEqual(codexGoalRoute(text, [], false), { type: "set", objective: "x" });
  }),
);

it.effect("an agent $deploy ship it still matches the Grok skill parser", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: "$deploy ship it",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      ...untouched,
    });

    assert.deepEqual(leadingGrokSkillMention(text), { name: "deploy", rest: " ship it" });
  }),
);

it.effect("still headers prose that only looks like a command or a price", () =>
  Effect.gen(function* () {
    for (const text of ["/please review this", "$25 off"]) {
      const providerText = yield* providerTextForTurn({
        text,
        attachments: [],
        createdBy: "agent",
        senderThreadId,
        ...lookups,
      });
      assert.equal(
        providerText,
        `Agent-authored message from "Review 'the' PR", not the user.\n${text}`,
      );
    }
  }),
);
