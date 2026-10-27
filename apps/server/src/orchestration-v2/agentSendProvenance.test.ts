import { assert, it } from "@effect/vitest";
import { parseGoalCommand, ThreadId } from "@t3tools/contracts";
import { leadingGrokSkillMention } from "@t3tools/provider-grok/server/skills";
import { parsePiCompactCommand } from "@t3tools/provider-pi/server/commands";
import * as Effect from "effect/Effect";

import { providerTextForTurn } from "./agentSendProvenance.ts";
import { planClaudeSkillDispatch } from "../provider/Drivers/ClaudeSkillDispatch.ts";

const senderThreadId = ThreadId.make("thread:child-review");
const body = "Please merge the PR now.\n";
const header = (text: string, name = `"Review 'the' PR"`) =>
  `Agent-authored message from ${name}, not the user.\n${text}`;
const claudeSkills = new Map([["deploy", { path: "/skills/deploy/SKILL.md" }]]);

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
      createdBy: "agent",
      senderThreadId,
      ...lookups,
    });

    assert.equal(text, header(body));
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

    assert.equal(text, header(body, senderThreadId));
  }),
);

it.effect("leaves a user message untouched and does no extra work", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: "/compress",
      createdBy: "user",
      senderThreadId,
      ...untouched,
    });

    assert.equal(text, "/compress");
  }),
);

it.effect("leaves a system message unchanged", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      createdBy: "system",
      senderThreadId,
      ...untouched,
    });

    assert.equal(text, body);
  }),
);

it.effect("an agent /compact still compacts", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: " /compact ",
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
      createdBy: "agent",
      senderThreadId,
      ...untouched,
    });

    assert.deepEqual(parseGoalCommand({ text }), { type: "set", objective: "x" });
  }),
);

it.effect("an agent $deploy ship it still matches the Grok skill parser", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: "$deploy ship it",
      createdBy: "agent",
      senderThreadId,
      ...untouched,
    });

    assert.deepEqual(leadingGrokSkillMention(text), { name: "deploy", rest: " ship it" });
  }),
);

it.effect("keeps a leading slash raw, including Cursor /compress and a Claude legacy command", () =>
  Effect.gen(function* () {
    for (const text of [
      "/compress",
      "/legacy files",
      "/review staged changes",
      "/please review this",
      "/my-command",
      "/skill:deploy",
    ]) {
      const providerText = yield* providerTextForTurn({
        text,
        createdBy: "agent",
        senderThreadId,
        ...untouched,
      });
      assert.equal(providerText, text);
    }
  }),
);

it.effect("keeps a leading skill token raw and still headers a price or a later mention", () =>
  Effect.gen(function* () {
    const home = yield* providerTextForTurn({
      text: "$HOME is unset; use the fallback.",
      createdBy: "agent",
      senderThreadId,
      ...untouched,
    });
    assert.equal(home, "$HOME is unset; use the fallback.");

    const price = yield* providerTextForTurn({
      text: "$25 off",
      createdBy: "agent",
      senderThreadId,
      ...lookups,
    });
    assert.equal(price, header("$25 off"));

    const later = yield* providerTextForTurn({
      text: "Ship $deploy now",
      createdBy: "agent",
      senderThreadId,
      readSenderTitle: () => Effect.succeed("Review $deploy job"),
      readReceiverSubagents: () => Effect.succeed([]),
    });
    assert.equal(
      later,
      `Agent-authored message from "Review $\u2060deploy job", not the user.\nShip $deploy now`,
    );
    const plan = planClaudeSkillDispatch(later, claudeSkills);
    assert.equal(plan?.skillName, "deploy");
    assert.equal(plan?.commandText, "/deploy now");
  }),
);

it.effect("a skill token in the sender title does not invoke that skill", () =>
  Effect.gen(function* () {
    for (const title of ["Review $deploy job", "Review €deploy job", "Review £deploy job"]) {
      const text = yield* providerTextForTurn({
        text: "The review is complete.",
        createdBy: "agent",
        senderThreadId,
        readSenderTitle: () => Effect.succeed(title),
        readReceiverSubagents: () => Effect.succeed([]),
      });
      assert.isUndefined(planClaudeSkillDispatch(text, claudeSkills));
    }
  }),
);
