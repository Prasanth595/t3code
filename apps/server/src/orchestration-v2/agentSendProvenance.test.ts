import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { leadingGrokSkillMention } from "@t3tools/provider-grok/server/skills";
import { parsePiCompactCommand } from "@t3tools/provider-pi/server/commands";
import * as Effect from "effect/Effect";

import { parseCodexGoalCommand } from "./Adapters/CodexAdapterV2.ts";
import { providerTextForTurn, type ReceiverNativeSurface } from "./agentSendProvenance.ts";
import { planClaudeSkillDispatch } from "../provider/Drivers/ClaudeSkillDispatch.ts";

const senderThreadId = ThreadId.make("thread:child-review");
const body = "Please merge the PR now.\n";
const codex = ProviderDriverKind.make("codex");
const grok = ProviderDriverKind.make("grok");
const pi = ProviderDriverKind.make("pi");
const claude = ProviderDriverKind.make("claude");
const opencode = ProviderDriverKind.make("opencode");
const header = (text: string, name = `"Review 'the' PR"`) =>
  `Agent-authored message from ${name}, not the user.\n${text}`;
const file = ChatFileAttachment.make({
  type: "file",
  id: ChatAttachmentId.make("compact-file-12345678-1234-1234-1234-123456789abc"),
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
});
const deploySkill = {
  slashCommands: [],
  skills: [{ name: "deploy", enabled: true }],
} satisfies ReceiverNativeSurface;
const disabledDeploy = {
  slashCommands: [],
  skills: [{ name: "deploy", enabled: false }],
} satisfies ReceiverNativeSurface;
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
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: codex,
      ...lookups,
    });

    assert.equal(text, header(body));
  }),
);

it.effect("uses the thread id when the title is blank", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: codex,
      readSenderTitle: () => Effect.succeed(" \n\t "),
      readReceiverSubagents: () => Effect.succeed([]),
    });

    assert.equal(text, header(body, senderThreadId));
  }),
);

it.effect("leaves a system message unchanged", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: body,
      attachments: [],
      createdBy: "system",
      senderThreadId,
      driver: codex,
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
      driver: codex,
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
      driver: codex,
      ...untouched,
    });

    assert.deepEqual(parseCodexGoalCommand(text), { type: "set", objective: "x" });
  }),
);

it.effect("an agent $deploy ship it still matches the Grok skill parser", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: "$deploy ship it",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: grok,
      nativeSurface: deploySkill,
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
        driver: codex,
        ...lookups,
      });
      assert.equal(providerText, header(text));
    }
  }),
);

it.effect("headers unknown and disabled Grok skills, including on other drivers", () =>
  Effect.gen(function* () {
    const cases = [
      { driver: grok, text: "$HOME is unset; use the fallback.", nativeSurface: undefined },
      { driver: grok, text: "$deploy ship it", nativeSurface: disabledDeploy },
      { driver: codex, text: "$HOME is unset; use the fallback.", nativeSurface: deploySkill },
      { driver: codex, text: "$deploy ship it", nativeSurface: deploySkill },
    ] as const;
    for (const input of cases) {
      const providerText = yield* providerTextForTurn({
        text: input.text,
        attachments: [],
        createdBy: "agent",
        senderThreadId,
        driver: input.driver,
        ...(input.nativeSurface === undefined ? {} : { nativeSurface: input.nativeSurface }),
        ...lookups,
      });
      assert.equal(providerText, header(input.text));
    }
  }),
);

it.effect("headers Codex /compact when a file is attached, and Pi compact only on Pi", () =>
  Effect.gen(function* () {
    const withFile = yield* providerTextForTurn({
      text: "/compact",
      attachments: [file],
      createdBy: "agent",
      senderThreadId,
      driver: codex,
      ...lookups,
    });
    assert.equal(withFile, header("/compact"));

    const argued = yield* providerTextForTurn({
      text: "/compact keep API details",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: codex,
      ...lookups,
    });
    assert.equal(argued, header("/compact keep API details"));

    const piCompact = yield* providerTextForTurn({
      text: "/compact keep API details",
      attachments: [file],
      createdBy: "agent",
      senderThreadId,
      driver: pi,
      ...untouched,
    });
    assert.equal(piCompact, "/compact keep API details");
  }),
);

it.effect("keeps a discovered command only for the driver that has it", () =>
  Effect.gen(function* () {
    const review = {
      slashCommands: [{ name: "review" }],
      skills: [],
    } satisfies ReceiverNativeSurface;
    const kept = yield* providerTextForTurn({
      text: "/review staged changes",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: opencode,
      nativeSurface: review,
      ...untouched,
    });
    assert.equal(kept, "/review staged changes");

    const unknown = yield* providerTextForTurn({
      text: "/review staged changes",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: opencode,
      ...lookups,
    });
    assert.equal(unknown, header("/review staged changes"));

    const prose = yield* providerTextForTurn({
      text: "/please review this",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: opencode,
      nativeSurface: review,
      ...lookups,
    });
    assert.equal(prose, header("/please review this"));
  }),
);

it.effect("keeps Pi custom commands and skill invocations", () =>
  Effect.gen(function* () {
    const surface = {
      slashCommands: [{ name: "my-command" }],
      skills: [{ name: "deploy", enabled: true }],
    } satisfies ReceiverNativeSurface;
    for (const text of ["/my-command", "/skill:deploy"]) {
      const providerText = yield* providerTextForTurn({
        text,
        attachments: [],
        createdBy: "agent",
        senderThreadId,
        driver: pi,
        nativeSurface: surface,
        ...untouched,
      });
      assert.equal(providerText, text);
    }
    const missing = yield* providerTextForTurn({
      text: "/my-command",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: pi,
      ...lookups,
    });
    assert.equal(missing, header("/my-command"));
  }),
);

it.effect("a skill token in the sender title does not invoke that skill", () =>
  Effect.gen(function* () {
    for (const title of ["Review $deploy job", "Review €deploy job", "Review £deploy job"]) {
      const text = yield* providerTextForTurn({
        text: "The review is complete.",
        attachments: [],
        createdBy: "agent",
        senderThreadId,
        driver: claude,
        readSenderTitle: () => Effect.succeed(title),
        readReceiverSubagents: () => Effect.succeed([]),
      });
      assert.isUndefined(planClaudeSkillDispatch(text, claudeSkills));
    }

    const intentional = yield* providerTextForTurn({
      text: "Ship $deploy now",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: claude,
      readSenderTitle: () => Effect.succeed("Review $deploy job"),
      readReceiverSubagents: () => Effect.succeed([]),
    });
    const plan = planClaudeSkillDispatch(intentional, claudeSkills);
    assert.equal(plan?.skillName, "deploy");
    assert.equal(plan?.commandText, "/deploy now");
  }),
);

it.effect("a Codex goal is ordinary text for every other driver", () =>
  Effect.gen(function* () {
    const text = yield* providerTextForTurn({
      text: "/goal clear",
      attachments: [],
      createdBy: "agent",
      senderThreadId,
      driver: opencode,
      ...lookups,
    });
    assert.equal(text, header("/goal clear"));
  }),
);
