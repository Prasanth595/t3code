/**
 * Offline tests for the Muse ACP bridge. No Muse account, model, network or
 * subscription is touched: the bridge runs as a real child process speaking
 * JSON-RPC, and its "worker" is a fake executable that replays event shapes
 * observed in real Muse worker logs (fixtures/muse-acp-events.sanitized.jsonl).
 *
 * What this proves: prompt assembly, required-context delivery and event
 * translation inside the bridge. What it does NOT prove: that a live Muse,
 * Claude or Codex model obeys a skill or reference it was given. The
 * "consequence" tests are transport fixtures: the fake worker computes an
 * answer from the delivered text, so a missing reference is visible as a wrong
 * answer, but no model is involved.
 *
 *   node --test scripts/nofun/muse-acp.test.mjs
 *   MUSE_ACP_BRIDGE=/path/to/other/muse-acp.mjs node --test ...   (run the same suite against another bridge build)
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const assert = NodeAssert;
const { spawn } = NodeChildProcess;
const { createHash } = NodeCrypto;
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = NodeFS;
const { tmpdir } = NodeOS;
const { dirname, join } = NodePath;
const { createInterface } = NodeReadline;
const { after, afterEach, before, describe, test } = NodeTest;
const { fileURLToPath } = NodeURL;

import {
  RECAP_LIMIT,
  REQUIRED_CONTEXT_LIMIT,
  boundReason,
  buildPromptFile,
  buildRecap,
  createEventTranslator,
  mergeRequired,
  requiredReceipts,
  splitPrompt,
} from "./muse-acp.logic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.MUSE_ACP_BRIDGE ?? join(here, "muse-acp.mjs");
const FIXTURE = join(here, "fixtures", "muse-acp-events.sanitized.jsonl");
const fixtureEvents = () =>
  readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.payload_type);

const ACP_TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
// The consumer (AcpRuntimeModel.normalizeToolCallStatus) understands these four; "cancelled" is not among them.
const CONSUMER_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

const translateAll = (events, translator = createEventTranslator()) =>
  events.flatMap((event) => translator.translate(event));
const toolUpdates = (actions) =>
  actions.filter((action) => action.type === "update").map((action) => action.body);

// ── Event translation (observed worker event shapes) ────────────────────────

describe("worker event translation", () => {
  const updates = toolUpdates(translateAll(fixtureEvents()));
  const byCall = (id) => updates.filter((update) => update.toolCallId === id);
  const begin = (title) =>
    updates.find((update) => update.sessionUpdate === "tool_call" && update.title === title);
  const trail = (title) =>
    byCall(begin(title).toolCallId).map((update) => update.status ?? "(info)");

  test("only tool tasks become tool calls, with ACP kinds and consumer statuses", () => {
    const begins = updates.filter((update) => update.sessionUpdate === "tool_call");
    assert.deepEqual(
      begins.map((update) => update.title),
      [
        "Read skill",
        "Read file",
        "Read file",
        "Edit file",
        "Write file",
        "Run command",
        "Send command input",
        "Fetch URL",
        "Tool: future_tool",
      ],
    );
    for (const update of updates) {
      assert.ok(
        update.status === undefined || CONSUMER_STATUSES.has(update.status),
        `status ${update.status}`,
      );
      if (update.sessionUpdate === "tool_call")
        assert.ok(ACP_TOOL_KINDS.has(update.kind), `kind ${update.kind}`);
    }
  });

  test("one stable id carries a call from begin to settle, and each call begins and settles once", () => {
    const ids = new Set(updates.map((update) => update.toolCallId));
    for (const id of ids) {
      const own = byCall(id);
      assert.equal(own.filter((update) => update.sessionUpdate === "tool_call").length, 1);
      assert.equal(own[0].sessionUpdate, "tool_call");
      assert.ok(
        own.filter((update) => update.status === "completed" || update.status === "failed")
          .length <= 1,
      );
    }
  });

  test("lifecycle order maps to pending → in_progress → completed or failed", () => {
    assert.deepEqual(trail("Read skill"), ["pending", "in_progress", "completed"]);
    assert.deepEqual(trail("Run command"), ["pending", "failed"]); // rejected before it ever started
    assert.deepEqual(trail("Send command input"), ["pending", "in_progress", "failed"]);
    assert.deepEqual(trail("Fetch URL"), ["pending", "in_progress", "failed"]);
  });

  test("failures carry a bounded reason; cancelled stays visible as cancelled", () => {
    const text = (title) =>
      byCall(begin(title).toolCallId)
        .flatMap((update) => update.content ?? [])
        .map((entry) => entry.content.text);
    assert.deepEqual(text("Run command"), [
      "Rejected: unsandboxed execution requires human approval, but approval prompts are disabled",
    ]);
    assert.deepEqual(text("Send command input"), ["Cancelled: terminated by bash_input"]);
    assert.deepEqual(text("Fetch URL"), ["Failed: web_fetch failed: HTTP 404 Not Found"]);
  });

  test("edit results add the edited path and line counts, once", () => {
    const edit = byCall(begin("Edit file").toolCallId);
    assert.deepEqual(edit.at(-1).locations, [{ path: "src/example.txt" }]);
    assert.equal(edit.at(-1).content[0].content.text, "+3 -1 lines");
    assert.equal(edit.filter((update) => update.locations).length, 1);
    assert.equal(
      byCall(begin("Write file").toolCallId).at(-1).content[0].content.text,
      "+12 lines",
    );
  });

  test("a call with no terminal event is left unfinished, not completed", () => {
    assert.deepEqual(trail("Tool: future_tool"), ["pending", "in_progress"]);
  });

  test("a result for a call that never began is ignored", () => {
    const translator = createEventTranslator();
    const orphan = fixtureEvents().find((event) => event.payload.text === "SENTINEL-ORPHAN-OUTPUT");
    assert.deepEqual(translator.translate(orphan), []);
  });

  test("a read never claims the skill or file was applied or even named", () => {
    const skill = byCall(begin("Read skill").toolCallId);
    assert.equal(skill[0].kind, "read");
    for (const update of updates) {
      assert.doesNotMatch(JSON.stringify(update), /appl(y|ied)|follow(ed)?|used skill|loaded/i);
      assert.equal(update.rawInput, undefined);
      assert.equal(update.rawOutput, undefined);
    }
    assert.equal(
      skill.find((update) => update.content),
      undefined,
      "no output text for a skill read",
    );
  });

  test("raw tool output, arguments and credentials never reach an update", () => {
    const serialized = JSON.stringify(updates);
    assert.doesNotMatch(serialized, /SENTINEL|sk-live|tool failed:|tool-output:\/\//);
  });

  test("replaying the whole log yields no duplicate tool calls or output", () => {
    const events = fixtureEvents();
    const translator = createEventTranslator();
    const once = translateAll(events, translator);
    assert.deepEqual(translateAll(events, translator), []);
    assert.deepEqual(translateAll([...events, ...events]), once);
  });

  test("a settled call never moves back, and a late result cannot reopen it", () => {
    const translator = createEventTranslator();
    const events = fixtureEvents();
    translateAll(events, translator);
    const started = events.find(
      (event) => event.payload_type === "task.lifecycle.started" && event.payload.task_id,
    );
    const again = { ...started, id: "replayed-with-a-new-id" };
    assert.deepEqual(translator.translate(again), []);
  });

  test("answer text passes through as before", () => {
    const actions = translateAll(fixtureEvents());
    assert.equal(
      actions
        .filter((action) => action.type === "delta")
        .map((action) => action.text)
        .join(""),
      "Checked the fixture.\nSTATUS: DONE\n",
    );
    assert.deepEqual(
      actions.find((action) => action.type === "final"),
      { type: "final", text: "Checked the fixture.\nSTATUS: DONE\n" },
    );
  });

  test("unknown event types and shapes are ignored without inference", () => {
    const translator = createEventTranslator();
    for (const event of [
      { payload_type: "task.lifecycle.next-thing", payload: { task_id: "x" } },
      { payload_type: "tool.result" },
      {},
      null,
    ]) {
      assert.deepEqual(translator.translate(event), []);
    }
  });

  test("failure reasons are one line, bounded and scrubbed of credentials", () => {
    const reason = boundReason(
      "curl failed\nAuthorization: Bearer abcdef1234567890 token=hunter22 https://user:pw@example.com key sk-live-0123456789abcdef " +
        "x".repeat(400),
    );
    assert.doesNotMatch(reason, /abcdef1234567890|hunter22|user:pw|sk-live|\n/);
    assert.ok(reason.length <= 201);
    assert.equal(boundReason(42), undefined);
  });
});

// ── Prompt assembly ─────────────────────────────────────────────────────────

const sha = (text) => createHash("sha256").update(text).digest("hex");
const entryOf = (kind, uri, text, extra = {}) => ({
  kind,
  uri,
  text,
  sha256: sha(text),
  requires: [],
  ...extra,
});
const skillEntry = entryOf(
  "skill-entry",
  "skill://fee-check/SKILL.md",
  "# fee-check\nFORMULA: fee = units * RATE + SURCHARGE\n",
);
const reference = entryOf(
  "reference",
  "skill://fee-check/references/rates.md",
  "RATE=7\nSURCHARGE=3\n",
);

describe("required context and recap", () => {
  test("plain text stays the request; only an explicit embedded resource becomes required", () => {
    const { request, required, problems } = splitPrompt([
      { type: "text", text: "Use the fee-check skill. $fee-check" },
      { type: "resource_link", uri: "file:///work/notes.md", name: "notes" },
      {
        type: "resource",
        resource: { uri: skillEntry.uri, mimeType: "text/markdown", text: skillEntry.text },
      },
      { type: "resource", resource: { uri: reference.uri, text: reference.text } },
      { type: "resource", resource: { uri: "file:///work/blob.bin", blob: "AAAA" } },
      { type: "resource", resource: { text: "unnamed text stays inline" } },
    ]);
    assert.deepEqual(required, [skillEntry, reference]);
    assert.deepEqual(problems, []);
    assert.equal(
      request,
      "Use the fee-check skill. $fee-check\n\n@file:///work/notes.md\n\n@file:///work/blob.bin\n\nunnamed text stays inline",
    );
  });

  test("a text fence counts only when its declared length and END line match", () => {
    const good = `=== BEGIN REQUIRED CONTEXT kind=reference uri=skill://a/references/x.md chars=5 ===\nhello\n=== END REQUIRED CONTEXT uri=skill://a/references/x.md ===`;
    const wrongLength = good.replace("chars=5", "chars=4");
    const { request, required } = splitPrompt([
      { type: "text", text: `before\n${good}\nafter ${wrongLength}` },
    ]);
    assert.deepEqual(required, [entryOf("reference", "skill://a/references/x.md", "hello")]);
    assert.match(
      request,
      /^before\n\[required context skill:\/\/a\/references\/x\.md \(reference, 5 chars\) is delivered separately\]\nafter /,
    );
    assert.ok(request.includes("chars=4"), "a mismatched fence is left as ordinary text");
  });

  test("the latest delivery of a uri wins, and an over-limit set is refused without truncation", () => {
    const first = mergeRequired(new Map(), [skillEntry, reference]).required;
    const second = mergeRequired(first, [
      entryOf("reference", reference.uri, "RATE=9\nSURCHARGE=3\n"),
    ]).required;
    assert.equal(second.get(reference.uri).text, "RATE=9\nSURCHARGE=3\n");
    assert.equal(first.get(reference.uri).text, reference.text, "the earlier map is not mutated");
    const refused = mergeRequired(second, [
      entryOf("reference", "skill://big/references/huge.md", "x".repeat(REQUIRED_CONTEXT_LIMIT)),
    ]);
    assert.match(
      refused.error,
      /over the 120000 limit \(largest: skill:\/\/big\/references\/huge\.md, 120000\)\. Nothing was truncated/,
    );
    assert.equal(refused.required, undefined);
  });

  test("content identity: digest, caller revision and declared references travel with an entry", () => {
    const text = "RATE=7\n";
    const { required, problems } = splitPrompt([
      {
        type: "resource",
        resource: {
          uri: "skill://s/SKILL.md",
          text: "see rates",
          _meta: {
            revision: "r42",
            requires: ["skill://s/references/rates.md"],
            sha256: sha("see rates"),
          },
        },
      },
      { type: "resource", resource: { uri: "skill://s/references/rates.md", text } },
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(requiredReceipts(new Map(required.map((entry) => [entry.uri, entry]))), [
      {
        kind: "skill-entry",
        uri: "skill://s/SKILL.md",
        chars: 9,
        sha256: sha("see rates"),
        revision: "r42",
        requires: ["skill://s/references/rates.md"],
      },
      { kind: "reference", uri: "skill://s/references/rates.md", chars: 7, sha256: sha(text) },
    ]);
    const file = buildPromptFile({
      required: new Map(required.map((entry) => [entry.uri, entry])),
      history: [],
      request: "go",
    });
    assert.ok(
      file.includes(
        `chars=9 sha256=${sha("see rates")} revision=r42 requires=skill://s/references/rates.md ===`,
      ),
    );
  });

  test("a digest that does not match the delivered content is a problem, not a silent accept", () => {
    const wrong = sha("something else");
    const resource = splitPrompt([
      {
        type: "resource",
        resource: { uri: "skill://s/references/a.md", text: "abc", _meta: { sha256: wrong } },
      },
    ]);
    assert.equal(resource.required.length, 0);
    assert.match(
      resource.problems[0],
      new RegExp(
        `skill://s/references/a\\.md declares sha256 ${wrong} but its content hashes to ${sha("abc")}`,
      ),
    );
    const fenced = splitPrompt([
      {
        type: "text",
        text: `=== BEGIN REQUIRED CONTEXT kind=reference uri=skill://s/references/a.md chars=3 sha256=${wrong} ===\nabc\n=== END REQUIRED CONTEXT uri=skill://s/references/a.md ===`,
      },
    ]);
    assert.equal(fenced.problems.length, 1);
  });

  test("a declared reference that was not delivered is reported by name instead of skipped", () => {
    const entry = entryOf("skill-entry", "skill://s/SKILL.md", "uses rates", {
      requires: ["skill://s/references/rates.md", "skill://s/references/extra.md"],
    });
    const refused = mergeRequired(new Map(), [entry]);
    assert.match(
      refused.error,
      /Required reference\(s\) not delivered: skill:\/\/s\/references\/rates\.md \(declared by skill:\/\/s\/SKILL\.md\), skill:\/\/s\/references\/extra\.md/,
    );
    const rates = entryOf("reference", "skill://s/references/rates.md", "RATE=1");
    assert.match(mergeRequired(new Map(), [entry, rates]).error, /extra\.md/);
    const extra = entryOf("reference", "skill://s/references/extra.md", "x=1");
    assert.equal(mergeRequired(new Map(), [entry, rates, extra]).error, undefined);
  });

  test("the recap keeps the newest whole turns within its limit and says what it dropped", () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      prompt: `ask ${index}`,
      answer: String(index).repeat(6_000),
    }));
    const recap = buildRecap(history);
    assert.ok(recap.length <= RECAP_LIMIT, `recap ${recap.length}`);
    assert.match(recap, /^\(3 earlier turn\(s\) are omitted from this recap\.\)/);
    assert.match(recap, /### Turn 4\nRequest:\nask 3/);
    assert.match(recap, /### Turn 6\nRequest:\nask 5/);
    assert.doesNotMatch(recap, /ask 2/);
    const huge = buildRecap([{ prompt: "p", answer: "z".repeat(50_000) }]);
    assert.ok(huge.length <= RECAP_LIMIT);
    assert.match(huge, /newest turn alone exceeds 20000 characters/);
  });

  test("a declared required fence with missing content fails instead of becoming ordinary text", () => {
    const parsed = splitPrompt([
      {
        type: "text",
        text: "=== BEGIN REQUIRED CONTEXT kind=reference uri=skill://s/reference.md chars=99 ===\nshort",
      },
    ]);
    assert.equal(parsed.required.length, 0);
    assert.match(parsed.problems.join(" "), /invalid length or missing END fence/);
  });

  test("a prompt with no required context and no history is exactly the request", () => {
    assert.equal(buildPromptFile({ required: new Map(), history: [], request: "hi" }), "hi");
  });

  test("required context leads, verbatim and length-labelled; the latest request is last and whole", () => {
    const required = new Map([
      [reference.uri, reference],
      [skillEntry.uri, skillEntry],
    ]);
    const history = [{ prompt: "old ask", answer: "old answer" }];
    const request = "units=6\n" + "tail ".repeat(10_000);
    const file = buildPromptFile({ required, history, request });
    assert.ok(
      file.indexOf("kind=skill-entry") < file.indexOf("kind=reference"),
      "skill entry before references",
    );
    assert.ok(
      file.includes(
        `chars=${skillEntry.text.length} sha256=${skillEntry.sha256} ===\n${skillEntry.text}\n=== END REQUIRED CONTEXT`,
      ),
    );
    assert.ok(
      file.indexOf("BEGIN REQUIRED CONTEXT") < file.indexOf("Earlier in this conversation"),
    );
    assert.ok(file.endsWith(`Current request:\n${request}`));
    // What the bridge writes is itself a valid fence stream: parsing it recovers the same entries.
    const roundTrip = splitPrompt([{ type: "text", text: file }]);
    assert.deepEqual(
      new Set(roundTrip.required.map((entry) => entry.uri)),
      new Set([skillEntry.uri, reference.uri]),
    );
  });
});

// ── Real cross-route caller shapes (read-only imports of the app's own helpers) ──

describe("caller shapes per route", () => {
  // Source-read, not run: GrokAdapterV2 is an AcpAdapterV2 flavor, so Grok gets the same text-only ACP prompt as Muse and
  // resolves skills itself (GrokDriver.discoverGrokSkills lists them for the catalog). The Muse assertions below are
  // therefore the shape both ACP routes share; Grok's live behaviour is not exercised here.
  test("Claude and Codex name a skill; the ACP prompt Muse and Grok receive is text only, so nothing is required context", async () => {
    const { planClaudeSkillDispatch } =
      await import("../../apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts");
    const { t3AcpPromptWithInstructions } =
      await import("../../apps/server/src/provider/T3OrchestrationInstructions.ts");
    const { SKILL_MENTION_PATTERN } =
      await import("../../packages/shared/src/composerInlineTokens.ts");

    const message = "Please run $fee-check for units=6";
    // Claude: the mention becomes `/fee-check ...`; the SKILL.md and its references stay on Claude's own disk.
    const claude = planClaudeSkillDispatch(message, new Set(["fee-check"]));
    assert.equal(claude.skillName, "fee-check");
    assert.match(claude.commandText, /^\/fee-check /);
    // Codex: the same mention is rewritten to `$name` (CodexAdapterV2.codexSkillMentionText) and Codex resolves it locally.
    assert.deepEqual(
      [...message.matchAll(SKILL_MENTION_PATTERN)].map((match) => match[2]),
      ["fee-check"],
    );
    // Muse over ACP: AcpAdapterV2 sends text blocks (wrapped instructions, then the user request).
    const wrapped = t3AcpPromptWithInstructions({
      prompt: message,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    const { request, required } = splitPrompt([
      { type: "text", text: wrapped },
      { type: "text", text: "<runtime instructions>" },
    ]);
    assert.deepEqual(
      required,
      [],
      "a skill name in prose is not delivered content and is never promoted",
    );
    assert.ok(request.includes("$fee-check"));
  });
});

// ── The bridge as a real JSON-RPC process ───────────────────────────────────

const FAKE_WORKER = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const prompt = readFileSync(flag("--prompt-file"), "utf8");
const dir = process.env.FAKE_MUSE_DIR;
mkdirSync(dir, { recursive: true });
const n = readdirSync(dir).filter((name) => name.startsWith("run-")).length + 1;
writeFileSync(join(dir, "run-" + n + ".json"), JSON.stringify({
  argv, prompt, cwd: process.cwd(),
  env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null, META_API_KEY: "META_API_KEY" in process.env, MUSE_AUTH_PATH: "MUSE_AUTH_PATH" in process.env },
}));
const request = prompt.includes("Current request:\\n") ? prompt.slice(prompt.lastIndexOf("Current request:\\n")) : prompt;
const scenario = /\\[\\[scenario:([a-z0-9:-]+)\\]\\]/.exec(request)?.[1] ?? "answer";
let seq = 0;
const emit = (payload_type, payload) => process.stdout.write(JSON.stringify({ schema_version: 1, id: "fake-" + n + "-" + (++seq), sequence: seq, record_type: "event", durability: "durable", payload_type, payload_schema_version: 1, payload }) + "\\n");
const finish = (text) => { emit("run.output.delta", { text }); emit("run.terminal.completed", { terminal: "completed", text, reason: null }); };
const blocks = () => {
  const found = [];
  const header = /^=== BEGIN REQUIRED CONTEXT kind=(\\S+) uri=(\\S+) chars=(\\d+)((?: \\w+=\\S+)*) ===\\n/gm;
  for (let m = header.exec(prompt); m; m = header.exec(prompt)) {
    const text = prompt.slice(m.index + m[0].length, m.index + m[0].length + Number(m[3]));
    const declared = /sha256=([0-9a-f]{64})/.exec(m[4])?.[1];
    // A block whose content does not hash to its declared identity is not trusted.
    if (declared && declared !== createHash("sha256").update(text).digest("hex")) continue;
    found.push({ kind: m[1], uri: m[2], text });
  }
  return found;
};
if (scenario === "tools" || scenario === "tools-twice") {
  const lines = readFileSync(process.env.FAKE_MUSE_FIXTURE, "utf8").split("\\n").filter(Boolean);
  for (let pass = 0; pass < (scenario === "tools" ? 1 : 2); pass += 1) for (const line of lines) process.stdout.write(line + "\\n");
} else if (scenario.startsWith("answer:")) {
  finish("A".repeat(Number(scenario.split(":")[1])));
} else if (scenario === "consequence") {
  // Stands in for a model that follows the skill it was handed: the formula comes from the skill entry,
  // the constants from the reference, the input from the latest request. Nothing is hard-coded.
  const found = blocks();
  const entry = found.find((block) => block.kind === "skill-entry");
  const constants = Object.fromEntries(found.filter((block) => block.kind === "reference").flatMap((block) => [...block.text.matchAll(/^(\\w+)=(\\d+)$/gm)].map((m) => [m[1], Number(m[2])])));
  const units = Number(/units=(\\d+)/.exec(request)?.[1]);
  const formula = /fee = units \\* (\\w+) \\+ (\\w+)/.exec(entry?.text ?? "");
  const missing = [!entry && "skill-entry", formula && !(formula[1] in constants) && formula[1], formula && !(formula[2] in constants) && formula[2]].filter(Boolean);
  finish(entry && missing.length === 0 ? "FEE=" + (units * constants[formula[1]] + constants[formula[2]]) : "FEE=UNKNOWN missing:" + (missing.join(",") || "formula"));
} else if (scenario === "hang") {
  process.on("SIGTERM", () => { writeFileSync(join(dir, "terminated-" + n), "1"); process.exit(143); });
  emit("run.output.delta", { text: "working" });
  setInterval(() => {}, 1000);
} else if (scenario === "exit2") {
  process.stderr.write("fake worker failed\\n");
  process.exit(2);
} else {
  finish("ok");
}
`;

describe("bridge process", () => {
  let root;
  let workspace;
  let fakeDir;
  let accountsPath;
  const baseEnv = () => {
    const env = {
      ...process.env,
      TMPDIR: join(root, "tmp"),
      FAKE_MUSE_DIR: fakeDir,
      FAKE_MUSE_FIXTURE: FIXTURE,
    };
    delete env.META_API_KEY;
    return env;
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "muse-acp-test-"));
    workspace = join(root, "workspace");
    fakeDir = join(root, "fake");
    mkdirSync(join(root, "tmp"));
    mkdirSync(workspace);
    const worker = join(root, "fake-muse-worker.mjs");
    writeFileSync(worker, FAKE_WORKER);
    chmodSync(worker, 0o755);
    accountsPath = join(root, "muse-accounts.json");
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [{ id: "test", workerExecutable: worker, configHome: join(root, "config") }],
      }),
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const runs = () =>
    readdirSync(fakeDir)
      .filter((name) => name.startsWith("run-"))
      .sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)))
      .map((name) => JSON.parse(readFileSync(join(fakeDir, name), "utf8")));

  const open = [];
  // A failed assertion must not leave a bridge (and its open stdin) behind.
  afterEach(async () => {
    for (const bridge of open.splice(0)) await bridge.close();
  });

  function startBridge(extraEnv = {}) {
    rmSync(fakeDir, { recursive: true, force: true });
    mkdirSync(fakeDir);
    const child = spawn(
      process.execPath,
      [BRIDGE, "--account", "test", "--accounts", accountsPath],
      {
        env: { ...baseEnv(), ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const notes = [];
    const lines = [];
    const pending = new Map();
    const watchers = [];
    let nextId = 1;
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push(line);
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method === "session/update") {
        notes.push(message.params);
        for (const watcher of watchers)
          if (watcher.test(message.params)) watcher.resolve(message.params);
      }
    });
    const write = (message) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const bridge = {
      notes,
      lines,
      request(method, params) {
        const id = nextId++;
        const response = new Promise((resolve) => pending.set(id, resolve));
        write({ id, method, params });
        return response;
      },
      notify: (method, params) => write({ method, params }),
      waitForNote: (test) =>
        new Promise((resolve) => {
          const seen = notes.find(test);
          if (seen) return resolve(seen);
          watchers.push({ test, resolve });
        }),
      async newSession() {
        const response = await bridge.request("session/new", { cwd: workspace, mcpServers: [] });
        return response.result.sessionId;
      },
      prompt: (sessionId, parts) => bridge.request("session/prompt", { sessionId, prompt: parts }),
      close() {
        closing ??= new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", resolve);
          child.stdin.end();
        });
        return closing;
      },
    };
    let closing;
    open.push(bridge);
    return bridge;
  }
  const textBlock = (text) => ({ type: "text", text });
  const toolNotes = (bridge) =>
    bridge.notes
      .map((note) => note.update)
      .filter((update) => update.sessionUpdate.startsWith("tool_call"));

  test("advertises embedded context and starts sessions on the read-only review profile", async () => {
    const bridge = startBridge();
    const init = await bridge.request("initialize", { protocolVersion: 1 });
    assert.equal(init.result.agentCapabilities.promptCapabilities.embeddedContext, true);
    const created = await bridge.request("session/new", { cwd: workspace });
    const options = Object.fromEntries(
      created.result.configOptions.map((option) => [option.id, option.currentValue]),
    );
    assert.deepEqual(options, { model: "muse-spark-1.3-contributor", profile: "muse-review" });
    await bridge.close();
  });

  test("tool events reach the app as ACP tool calls; answer text and stop reason are unchanged", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    const response = await bridge.prompt(sessionId, [textBlock("inspect [[scenario:tools]]")]);
    assert.equal(response.result.stopReason, "end_turn");
    const expected = toolUpdates(translateAll(fixtureEvents()));
    assert.deepEqual(toolNotes(bridge), expected);
    const answer = bridge.notes
      .filter((note) => note.update.sessionUpdate === "agent_message_chunk")
      .map((note) => note.update.content.text)
      .join("");
    assert.equal(answer, "Checked the fixture.\nSTATUS: DONE\n");
    assert.doesNotMatch(bridge.lines.join("\n"), /SENTINEL|sk-live/);
    await bridge.close();
  });

  test("a worker that replays its whole log does not duplicate tool calls or answer text", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    await bridge.prompt(sessionId, [textBlock("[[scenario:tools-twice]]")]);
    assert.deepEqual(toolNotes(bridge), toolUpdates(translateAll(fixtureEvents())));
    const answer = bridge.notes
      .filter((note) => note.update.sessionUpdate === "agent_message_chunk")
      .map((note) => note.update.content.text)
      .join("");
    assert.equal(answer, "Checked the fixture.\nSTATUS: DONE\n");
    await bridge.close();
  });

  test("the worker gets the session's profile and model flags and nothing that widens it", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    await bridge.prompt(sessionId, [textBlock("first")]);
    assert.equal(
      (
        await bridge.request("session/set_config_option", {
          sessionId,
          configId: "profile",
          value: "muse-judge",
        })
      ).result.configOptions[1].currentValue,
      "muse-judge",
    );
    assert.equal(
      (
        await bridge.request("session/set_config_option", {
          sessionId,
          configId: "profile",
          value: "muse-everything",
        })
      ).error.code,
      -32602,
    );
    await bridge.prompt(sessionId, [textBlock("second")]);
    const [first, second] = runs();
    for (const run of [first, second]) {
      assert.deepEqual(
        run.argv.filter((arg) => arg.startsWith("--")),
        ["--workspace", "--prompt-file", "--task-id", "--profile", "--model"],
      );
      assert.equal(run.argv[run.argv.indexOf("--workspace") + 1], workspace);
      assert.equal(run.argv[run.argv.indexOf("--model") + 1], "muse-spark-1.3-contributor");
    }
    assert.equal(first.argv[first.argv.indexOf("--profile") + 1], "muse-review");
    assert.equal(second.argv[second.argv.indexOf("--profile") + 1], "muse-judge");
    await bridge.close();
  });

  test("account isolation and the API-billing stop are unchanged", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    await bridge.prompt(sessionId, [textBlock("env")]);
    const [run] = runs();
    assert.deepEqual(run.env, {
      XDG_CONFIG_HOME: join(root, "config"),
      META_API_KEY: false,
      MUSE_AUTH_PATH: false,
    });
    await bridge.close();

    const blocked = startBridge({ META_API_KEY: "not-a-real-key" });
    const id = await blocked.newSession();
    const refused = await blocked.prompt(id, [textBlock("never runs")]);
    assert.match(
      refused.error.message,
      /META_API_KEY is set; Muse subscription routes refuse API billing\./,
    );
    assert.deepEqual(runs(), []);
    await blocked.close();
  });

  test("cancel answers cancelled, stops the worker, and a later prompt still runs", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    const running = bridge.prompt(sessionId, [textBlock("[[scenario:hang]]")]);
    await bridge.waitForNote((note) => note.update.content?.text === "working");
    bridge.notify("session/cancel", { sessionId });
    assert.equal((await running).result.stopReason, "cancelled");
    assert.ok(
      existsSync(join(fakeDir, "terminated-1")),
      "the worker received SIGTERM before the bridge answered",
    );
    const after = await bridge.prompt(sessionId, [textBlock("[[scenario:answer:3]]")]);
    assert.equal(after.result.stopReason, "end_turn");
    await bridge.close();
  });

  test("a failing worker surfaces its exit code and detail, and the turn is not remembered", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    const failed = await bridge.prompt(sessionId, [textBlock("[[scenario:exit2]]")]);
    assert.match(failed.error.message, /Muse worker exited with code 2\. fake worker failed/);
    await bridge.prompt(sessionId, [textBlock("next")]);
    assert.doesNotMatch(runs()[1].prompt, /Earlier in this conversation/);
    await bridge.close();
  });

  const ratesReference = (rate) => ({
    type: "resource",
    resource: {
      uri: reference.uri,
      mimeType: "text/markdown",
      text: `RATE=${rate}\nSURCHARGE=3\n`,
    },
  });
  const skillResource = {
    type: "resource",
    resource: { uri: skillEntry.uri, mimeType: "text/markdown", text: skillEntry.text },
  };
  const lastAnswer = (bridge) =>
    bridge.notes.findLast((note) => note.update.sessionUpdate === "agent_message_chunk").update
      .content.text;

  /** Two bulky turns push the recap past its 20k bound before the follow-up that needs the reference. */
  async function longConversation(bridge, firstTurn) {
    const sessionId = await bridge.newSession();
    await bridge.prompt(sessionId, [...firstTurn, textBlock("Prepare. [[scenario:answer:12000]]")]);
    await bridge.prompt(sessionId, [textBlock("More background. [[scenario:answer:12000]]")]);
    return sessionId;
  }

  test("embedded skill entry and reference survive an oversized history and change the fee computed", async () => {
    const bridge = startBridge();
    const sessionId = await longConversation(bridge, [skillResource, ratesReference(7)]);
    await bridge.prompt(sessionId, [
      textBlock("Compute the fee for units=6. [[scenario:consequence]]"),
    ]);
    assert.equal(lastAnswer(bridge), "FEE=45"); // 6 * 7 + 3, from the skill formula and the reference constants
    const file = runs()[2].prompt;
    assert.ok(file.includes(skillEntry.text) && file.includes("RATE=7\nSURCHARGE=3\n"));
    const recap = file.slice(
      file.indexOf("Earlier in this conversation"),
      file.indexOf("Current request:"),
    );
    assert.ok(recap.length <= RECAP_LIMIT + 400, `recap ${recap.length}`);
    assert.match(recap, /earlier turn\(s\) are omitted/);
    assert.ok(file.endsWith("Compute the fee for units=6. [[scenario:consequence]]"));
    await bridge.close();
  });

  test("a changed reference changes the result, and the newest delivery of a uri wins", async () => {
    const bridge = startBridge();
    const sessionId = await longConversation(bridge, [skillResource, ratesReference(7)]);
    await bridge.prompt(sessionId, [
      ratesReference(9),
      textBlock("units=6 [[scenario:consequence]]"),
    ]);
    assert.equal(lastAnswer(bridge), "FEE=57"); // 6 * 9 + 3
    await bridge.prompt(sessionId, [textBlock("units=1 [[scenario:consequence]]")]);
    assert.equal(lastAnswer(bridge), "FEE=12"); // 1 * 9 + 3: still the newest reference, delivered once
    await bridge.close();
  });

  test("control: the same conversation without the reference cannot compute the fee", async () => {
    const bridge = startBridge();
    const sessionId = await longConversation(bridge, [skillResource]);
    await bridge.prompt(sessionId, [textBlock("units=6 [[scenario:consequence]]")]);
    assert.equal(lastAnswer(bridge), "FEE=UNKNOWN missing:RATE,SURCHARGE");
    await bridge.close();
  });

  test("a text-only caller can deliver required context with the length-checked fence", async () => {
    const fence = (entry) =>
      `=== BEGIN REQUIRED CONTEXT kind=${entry.kind} uri=${entry.uri} chars=${entry.text.length} ===\n${entry.text}\n=== END REQUIRED CONTEXT uri=${entry.uri} ===`;
    const bridge = startBridge();
    const sessionId = await longConversation(bridge, [
      textBlock(`${fence(skillEntry)}\n\n${fence(reference)}`),
    ]);
    await bridge.prompt(sessionId, [textBlock("units=6 [[scenario:consequence]]")]);
    assert.equal(lastAnswer(bridge), "FEE=45");
    // The fenced text lives in the required record, not in the recap that may age out.
    assert.doesNotMatch(
      runs()[0].prompt.split("Current request:")[0],
      /Earlier in this conversation/,
    );
    assert.match(
      runs()[1].prompt,
      /\[required context skill:\/\/fee-check\/SKILL\.md \(skill-entry, \d+ chars\) is delivered separately\]/,
    );
    await bridge.close();
  });

  test("required context past its limit is refused with a clear error, no worker runs, and the session keeps working", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    await bridge.prompt(sessionId, [
      skillResource,
      ratesReference(7),
      textBlock("ok [[scenario:answer:2]]"),
    ]);
    const refused = await bridge.prompt(sessionId, [
      {
        type: "resource",
        resource: {
          uri: "skill://fee-check/references/huge.md",
          text: "x".repeat(REQUIRED_CONTEXT_LIMIT),
        },
      },
      textBlock("too much"),
    ]);
    assert.equal(refused.error.code, -32000);
    assert.match(
      refused.error.message,
      /Required context is \d+ characters, over the 120000 limit \(largest: skill:\/\/fee-check\/references\/huge\.md/,
    );
    assert.equal(runs().length, 1, "the refused prompt never started a worker");
    await bridge.prompt(sessionId, [textBlock("units=6 [[scenario:consequence]]")]);
    assert.equal(
      lastAnswer(bridge),
      "FEE=45",
      "earlier required context is intact after the refusal",
    );
    await bridge.close();
  });

  test("a skill whose declared reference is missing is refused by name, and delivering it unblocks the next prompt", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    const declaring = {
      type: "resource",
      resource: {
        ...skillResource.resource,
        _meta: { revision: "2026-10-14.1", requires: [reference.uri] },
      },
    };
    const refused = await bridge.prompt(sessionId, [
      declaring,
      textBlock("units=6 [[scenario:consequence]]"),
    ]);
    assert.equal(refused.error.code, -32000);
    assert.match(
      refused.error.message,
      new RegExp(
        `Required reference\\(s\\) not delivered: ${reference.uri.replace(/[/.]/g, "\\$&")} \\(declared by ${skillEntry.uri.replace(/[/.]/g, "\\$&")}\\)`,
      ),
    );
    assert.equal(runs().length, 0, "no worker started");

    const delivered = await bridge.prompt(sessionId, [
      declaring,
      ratesReference(7),
      textBlock("units=6 [[scenario:consequence]]"),
    ]);
    assert.equal(lastAnswer(bridge), "FEE=45");
    assert.deepEqual(delivered.result._meta.museAcp.requiredContext, [
      {
        kind: "skill-entry",
        uri: skillEntry.uri,
        chars: skillEntry.text.length,
        sha256: skillEntry.sha256,
        revision: "2026-10-14.1",
        requires: [reference.uri],
      },
      {
        kind: "reference",
        uri: reference.uri,
        chars: reference.text.length,
        sha256: reference.sha256,
      },
    ]);
    assert.ok(
      runs()[0].prompt.includes(
        `uri=${reference.uri} chars=${reference.text.length} sha256=${reference.sha256} ===`,
      ),
    );

    // A changed reference is a new identity, delivered and reported as such; an unchanged one is not re-sent.
    const changed = await bridge.prompt(sessionId, [
      ratesReference(9),
      textBlock("units=6 [[scenario:consequence]]"),
    ]);
    assert.equal(lastAnswer(bridge), "FEE=57");
    const receipt = changed.result._meta.museAcp.requiredContext.find(
      (entry) => entry.uri === reference.uri,
    );
    assert.equal(receipt.sha256, sha("RATE=9\nSURCHARGE=3\n"));
    assert.notEqual(receipt.sha256, reference.sha256);
    await bridge.close();
  });

  test("a refused prompt leaves the session's required context as it was", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    await bridge.prompt(sessionId, [ratesReference(7), textBlock("[[scenario:answer:2]]")]);
    const refused = await bridge.prompt(sessionId, [
      {
        type: "resource",
        resource: {
          ...skillResource.resource,
          _meta: { requires: ["skill://fee-check/references/absent.md"] },
        },
      },
      textBlock("[[scenario:answer:2]]"),
    ]);
    assert.ok(refused.error);
    await bridge.prompt(sessionId, [textBlock("[[scenario:answer:2]]")]);
    const prompt = runs().at(-1).prompt;
    assert.ok(prompt.includes(reference.uri) && !prompt.includes(skillEntry.uri));
    await bridge.close();
  });

  test("content that does not match its declared digest is refused before any worker runs", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    const refused = await bridge.prompt(sessionId, [
      {
        type: "resource",
        resource: {
          uri: reference.uri,
          text: reference.text,
          _meta: { sha256: sha("an older revision") },
        },
      },
      textBlock("go"),
    ]);
    assert.match(refused.error.message, /declares sha256 .* but its content hashes to /);
    assert.equal(runs().length, 0);
    await bridge.close();
  });

  test("a resource link stays a pointer: the bridge delivers its uri and reads nothing", async () => {
    const bridge = startBridge();
    const sessionId = await bridge.newSession();
    const secret = join(root, "do-not-read.md");
    writeFileSync(secret, "SENTINEL-FILE-CONTENT");
    await bridge.prompt(sessionId, [
      textBlock("see"),
      { type: "resource_link", uri: `file://${secret}`, name: "ref" },
    ]);
    assert.ok(runs()[0].prompt.includes(`@file://${secret}`));
    assert.ok(!runs()[0].prompt.includes("SENTINEL-FILE-CONTENT"));
    await bridge.close();
  });
});

// ── Routes this offline suite cannot exercise ──────────────────────────────

describe("live provider routes (blocked here, not passed)", () => {
  const routes = {
    muse: "needs a live Muse subscription run through the T3 Muse instance; the fake worker above is not a model",
    claude:
      "needs a live Claude Code root with the skill on disk; T3 only rewrites $name to /name and Claude reads SKILL.md and references from its own filesystem",
    codex:
      "needs a live Codex root; T3 only rewrites the mention to $name and Codex resolves the skill and its references from its own roots",
    grok: "needs the verified Grok / Cursor Cloud route; GrokAdapterV2 shares AcpAdapterV2's text-only prompt and Grok resolves skills itself",
  };
  for (const [route, reason] of Object.entries(routes)) {
    test(
      `${route}: real skill entry and reference reach the model and change a concrete result`,
      { skip: `BLOCKED: ${reason}` },
      () => {},
    );
  }
});
