/**
 * Pure logic for muse-acp.mjs: prompt assembly and worker-event translation.
 * No I/O, no process state, so scripts/nofun/muse-acp.test.mjs can drive it
 * directly and through a real bridge process.
 *
 * Install this file next to muse-acp.mjs; the bridge imports it by sibling path.
 */

import * as NodeCrypto from "node:crypto";

export const RECAP_LIMIT = 20_000;
/** Total characters of required context kept per session. Over it, the prompt fails rather than truncating. */
export const REQUIRED_CONTEXT_LIMIT = 120_000;

// ── Prompt assembly ─────────────────────────────────────────────────────────

const isSkillEntry = (uri) => /(^|[/\\])SKILL\.md$/i.test(uri);
const normalizeUri = (uri) => uri.replace(/\s/g, "%20");
const sha256 = (text) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * Required context is what a caller delivered explicitly and by name: an ACP
 * embedded `resource` block with a uri and text, or a text block carrying a
 * length-checked fence. Nothing else is treated as required. Plain text stays
 * the request; a `resource_link` stays an `@uri` pointer the bridge never reads.
 *
 * A required entry may declare, through `_meta` on the resource or attributes
 * on the fence header, a `revision` (caller's label), the `sha256` it expects
 * its content to have, and `requires`: references that must be delivered with
 * it. Declared-but-missing references and digest mismatches fail the prompt.
 *
 *   === BEGIN REQUIRED CONTEXT kind=<skill-entry|reference> uri=<uri> chars=<n> [sha256=<hex>] [revision=<r>] [requires=<uri>,<uri>] ===
 *   <exactly n characters>
 *   === END REQUIRED CONTEXT uri=<uri> ===
 */
const FENCE_HEADER =
  /^=== BEGIN REQUIRED CONTEXT kind=(skill-entry|reference) uri=(\S+) chars=(\d+)((?: (?:sha256|revision|requires)=\S+)*) ===\n/gm;

function makeEntry({ kind, uri, text, revision, requires }) {
  return {
    kind,
    uri: normalizeUri(uri),
    text,
    sha256: sha256(text),
    ...(revision ? { revision } : {}),
    requires: requires ?? [],
  };
}

function renderFence(entry) {
  const attributes = [
    `sha256=${entry.sha256}`,
    ...(entry.revision ? [`revision=${entry.revision}`] : []),
    ...(entry.requires.length > 0 ? [`requires=${entry.requires.join(",")}`] : []),
  ];
  return `=== BEGIN REQUIRED CONTEXT kind=${entry.kind} uri=${entry.uri} chars=${entry.text.length} ${attributes.join(" ")} ===\n${entry.text}\n=== END REQUIRED CONTEXT uri=${entry.uri} ===`;
}

const requiredPointer = (entry) =>
  `[required context ${entry.uri} (${entry.kind}, ${entry.text.length} chars) is delivered separately]`;

const digestProblem = (uri, expected, actual) =>
  `Required context ${uri} declares sha256 ${expected} but its content hashes to ${actual}. Nothing was delivered and no Muse worker was started.`;

/**
 * Lifts fenced required blocks out of a text block. A fence only counts when
 * its declared length is followed by the matching END line; anything else is
 * refused as malformed required context.
 */
function extractFenced(text, problems) {
  const required = [];
  let out = "";
  let cursor = 0;
  FENCE_HEADER.lastIndex = 0;
  for (let match = FENCE_HEADER.exec(text); match; match = FENCE_HEADER.exec(text)) {
    const [header, kind, uri, chars, attributes] = match;
    const bodyStart = match.index + header.length;
    const bodyEnd = bodyStart + Number(chars);
    const end = `\n=== END REQUIRED CONTEXT uri=${uri} ===`;
    if (!text.startsWith(end, bodyEnd)) {
      problems.push(
        `Required context ${normalizeUri(uri)} has an invalid length or missing END fence. No Muse worker was started.`,
      );
      continue;
    }
    const declared = Object.fromEntries(
      [...attributes.matchAll(/ (sha256|revision|requires)=(\S+)/g)].map((m) => [m[1], m[2]]),
    );
    const entry = makeEntry({
      kind,
      uri,
      text: text.slice(bodyStart, bodyEnd),
      revision: declared.revision,
      requires: declared.requires?.split(",").filter(Boolean).map(normalizeUri),
    });
    if (declared.sha256 && declared.sha256.toLowerCase() !== entry.sha256) {
      problems.push(digestProblem(entry.uri, declared.sha256, entry.sha256));
    } else {
      required.push(entry);
    }
    out += text.slice(cursor, match.index) + requiredPointer(entry);
    cursor = bodyEnd + end.length;
    FENCE_HEADER.lastIndex = cursor;
  }
  return { text: out + text.slice(cursor), required };
}

/** ACP prompt blocks → { request, required: [entry], problems: [message] }. */
export function splitPrompt(parts) {
  const request = [];
  const required = [];
  const problems = [];
  for (const part of parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string") {
      const fenced = extractFenced(part.text, problems);
      required.push(...fenced.required);
      request.push(fenced.text);
    } else if (part?.type === "resource_link") {
      request.push(`@${part.uri}`);
    } else if (part?.type === "resource") {
      const { uri, text, _meta } = part.resource ?? {};
      if (typeof text === "string" && typeof uri === "string" && uri) {
        const meta = _meta ?? part._meta ?? {};
        const entry = makeEntry({
          kind: isSkillEntry(uri) ? "skill-entry" : "reference",
          uri,
          text,
          revision: typeof meta.revision === "string" ? meta.revision : undefined,
          requires: Array.isArray(meta.requires)
            ? meta.requires.filter((value) => typeof value === "string").map(normalizeUri)
            : undefined,
        });
        if (typeof meta.sha256 === "string" && meta.sha256.toLowerCase() !== entry.sha256) {
          problems.push(digestProblem(entry.uri, meta.sha256, entry.sha256));
        } else {
          required.push(entry);
        }
      } else if (typeof text === "string") {
        request.push(text);
      } else {
        request.push(`@${uri ?? ""}`);
      }
    }
  }
  return { request: request.filter(Boolean).join("\n\n"), required, problems };
}

/** The session's required context after this prompt, or the error that refuses it. */
export function mergeRequired(current, incoming, limit = REQUIRED_CONTEXT_LIMIT) {
  const next = new Map(current);
  for (const entry of incoming) next.set(entry.uri, entry);
  const total = [...next.values()].reduce((sum, entry) => sum + entry.text.length, 0);
  if (total > limit) {
    const largest = [...next.values()].sort((a, b) => b.text.length - a.text.length)[0];
    return {
      error: `Required context is ${total} characters, over the ${limit} limit (largest: ${largest.uri}, ${largest.text.length}). Nothing was truncated and no Muse worker was started.`,
    };
  }
  const missing = [...next.values()].flatMap((entry) =>
    entry.requires
      .filter((uri) => !next.has(uri))
      .map((uri) => `${uri} (declared by ${entry.uri})`),
  );
  if (missing.length > 0) {
    return {
      error: `Required reference(s) not delivered: ${missing.join(", ")}. Deliver them with the skill; no Muse worker was started.`,
    };
  }
  return { required: next };
}

/** What a run's prompt carried, for the caller's evidence: identity, never "applied". */
export function requiredReceipts(required) {
  return [...required.values()].map((entry) => ({
    kind: entry.kind,
    uri: entry.uri,
    chars: entry.text.length,
    sha256: entry.sha256,
    ...(entry.revision ? { revision: entry.revision } : {}),
    ...(entry.requires.length > 0 ? { requires: entry.requires } : {}),
  }));
}

/** Newest whole turns that fit `limit`, with a note for what was dropped. */
export function buildRecap(history, limit = RECAP_LIMIT) {
  const blocks = history.map(
    (turn, index) =>
      `### Turn ${index + 1}\nRequest:\n${turn.prompt}\n\nYour answer:\n${turn.answer}`,
  );
  const kept = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const cost = blocks[index].length + (kept.length > 0 ? 2 : 0);
    if (used + cost > limit) break;
    kept.unshift(blocks[index]);
    used += cost;
  }
  let note = "";
  if (kept.length === 0 && blocks.length > 0) {
    kept.push(`…${blocks[blocks.length - 1].slice(-limit)}`);
    note = `(The newest turn alone exceeds ${limit} characters; its start is cut, and ${blocks.length - 1} earlier turn(s) are omitted.)\n\n`;
  } else if (kept.length < blocks.length) {
    note = `(${blocks.length - kept.length} earlier turn(s) are omitted from this recap.)\n\n`;
  }
  // Omission metadata consumes the same budget as the retained context.
  while (kept.length > 1 && note.length + kept.join("\n\n").length > limit) {
    kept.shift();
    note = `(${blocks.length - kept.length} earlier turn(s) are omitted from this recap.)\n\n`;
  }
  const bodyBudget = Math.max(0, limit - note.length);
  const body = kept.join("\n\n");
  return note.slice(0, limit) + (bodyBudget > 0 ? body.slice(-bodyBudget) : "");
}

/**
 * The worker prompt file. Required context comes first, verbatim and outside
 * the recap; the recap is bounded; the latest request is never trimmed.
 */
export function buildPromptFile({ required, history, request }) {
  const sections = [];
  if (required.size > 0) {
    const entries = [...required.values()].sort(
      (a, b) => Number(b.kind === "skill-entry") - Number(a.kind === "skill-entry"),
    );
    sections.push(
      `Required context (delivered verbatim by the caller; it applies to every turn of this session):\n\n${entries.map(renderFence).join("\n\n")}`,
    );
  }
  if (history.length > 0) {
    sections.push(
      `Earlier in this conversation (recap, for context only):\n\n${buildRecap(history)}`,
    );
  }
  if (sections.length === 0) return request;
  return `${sections.join("\n\n---\n\n")}\n\n---\n\nCurrent request:\n${request}`;
}

// ── Worker events → ACP updates ─────────────────────────────────────────────

// Muse tool name → ACP kind and a fixed title. The begin event carries no
// arguments, so a title never names a path, skill, or command.
const TOOLS = {
  read_file: ["read", "Read file"],
  read_skill: ["read", "Read skill"],
  search: ["search", "Search"],
  tool_search: ["search", "Search tools"],
  edit_file: ["edit", "Edit file"],
  write_file: ["edit", "Write file"],
  bash: ["execute", "Run command"],
  bash_input: ["execute", "Send command input"],
  web_fetch: ["fetch", "Fetch URL"],
  write_todos: ["other", "Update todos"],
  workflow: ["other", "Run workflow"],
};

const REASON_LIMIT = 200;
const SECRET_PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted]"],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@"],
  [
    /\b(api[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    "$1$2[redacted]",
  ],
];

/** A bounded, single-line, secret-scrubbed reason for a failed tool. */
export function boundReason(value) {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  if (!text) return undefined;
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text;
}

const textContent = (text) => [{ type: "content", content: { type: "text", text } }];

/**
 * Translates one worker's JSONL events. `translate(event)` returns actions:
 *   { type: "delta", text }     streamed answer text
 *   { type: "final", text }     the run's terminal answer
 *   { type: "update", body }    an ACP session/update body
 *
 * Only what the real event schema states is reported. A tool's ACP id is its
 * task id (present from the first event); `tool:<call_id>` keys and
 * `tool.result` join back to it. Output chunks, `tool.result.text` and output
 * refs are never forwarded. Events are deduplicated by id, a task begins once
 * and settles once, and a call with no terminal event is left as it is.
 */
export function createEventTranslator() {
  const seenEvents = new Set();
  const tasks = new Map(); // task id → { kind, status, locationSent }
  const taskByCall = new Map(); // call id → task id

  const update = (body) => ({
    type: "update",
    body: { sessionUpdate: "tool_call_update", ...body },
  });

  function settle(taskId, status, reason, label) {
    const task = tasks.get(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return [];
    task.status = status;
    const detail = boundReason(reason);
    const text = label ? (detail ? `${label}: ${detail}` : label) : undefined;
    return [
      update({
        toolCallId: taskId,
        status,
        ...(text ? { content: textContent(text) } : {}),
      }),
    ];
  }

  function translate(event) {
    if (typeof event?.id === "string") {
      if (seenEvents.has(event.id)) return [];
      seenEvents.add(event.id);
    }
    const payload = event?.payload ?? {};
    const inner = payload.event ?? {};
    const taskId = payload.task_id;
    switch (event?.payload_type) {
      case "run.output.delta":
        return typeof payload.text === "string" ? [{ type: "delta", text: payload.text }] : [];
      case "run.terminal.completed":
        return typeof payload.text === "string" ? [{ type: "final", text: payload.text }] : [];
      case "task.lifecycle.proposed": {
        const name = typeof inner.task_kind === "string" ? inner.task_kind : "";
        if (!name.startsWith("tool.") || typeof taskId !== "string" || tasks.has(taskId)) return [];
        const tool = name.slice("tool.".length);
        const [kind, title] = TOOLS[tool] ?? [
          "other",
          /^[A-Za-z0-9_.:-]{1,48}$/.test(tool) ? `Tool: ${tool}` : "Tool",
        ];
        tasks.set(taskId, { status: "pending", locationSent: false });
        return [
          {
            type: "update",
            body: {
              sessionUpdate: "tool_call",
              toolCallId: taskId,
              title,
              kind,
              status: "pending",
            },
          },
        ];
      }
      case "task.lifecycle.scheduled":
      case "task.lifecycle.side_effect_intent": {
        const key = inner.idempotency_key;
        if (tasks.has(taskId) && typeof key === "string" && key.startsWith("tool:")) {
          taskByCall.set(key.slice("tool:".length), taskId);
        }
        return [];
      }
      case "task.lifecycle.started": {
        const task = tasks.get(taskId);
        if (!task || task.status !== "pending") return [];
        task.status = "in_progress";
        return [update({ toolCallId: taskId, status: "in_progress" })];
      }
      case "task.lifecycle.completed":
        return settle(taskId, "completed");
      case "task.lifecycle.failed":
        return settle(taskId, "failed", inner.reason, "Failed");
      case "task.lifecycle.rejected":
        return settle(taskId, "failed", inner.reason, "Rejected");
      // ACP consumers know no cancelled status; it is reported as failed with the word kept.
      case "task.lifecycle.cancelled":
        return settle(taskId, "failed", inner.reason, "Cancelled");
      case "tool.result": {
        const id = taskByCall.get(payload.call_id);
        const task = id === undefined ? undefined : tasks.get(id);
        // A result for a call we never saw begin stays unknown.
        if (!task) return [];
        const outcome = payload.correlation_facts?.outcome;
        const actions = [];
        if (outcome === "success") actions.push(...settle(id, "completed"));
        else if (outcome === "failure") actions.push(...settle(id, "failed", undefined, "Failed"));
        else if (outcome === "cancelled")
          actions.push(...settle(id, "failed", undefined, "Cancelled"));
        const facts = payload.edit_facts;
        if (!task.locationSent && typeof facts?.path === "string" && facts.path) {
          task.locationSent = true;
          const lines = [
            typeof facts.added === "number" ? `+${facts.added}` : undefined,
            typeof facts.removed === "number" ? `-${facts.removed}` : undefined,
          ].filter(Boolean);
          actions.push(
            update({
              toolCallId: id,
              locations: [{ path: facts.path }],
              ...(lines.length > 0 ? { content: textContent(`${lines.join(" ")} lines`) } : {}),
            }),
          );
        }
        return actions;
      }
      default:
        return [];
    }
  }

  return { translate };
}
