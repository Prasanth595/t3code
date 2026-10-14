#!/usr/bin/env node
/**
 * muse-acp: one Muse Code subscription as an ACP agent, so T3 runs Muse like
 * any provider instance (delegate_task, Agents sidebar, completion wake-ups,
 * cancel) without a Muse-specific adapter.
 *
 *   muse-acp.mjs --account <id> [--accounts <path>]
 *
 * The account comes from ~/.nofun-t3/muse-accounts.json, the same file the
 * No Fun usage views read. Every prompt runs that account's worker launcher
 * (muse-worker.sh or a per-account wrapper) as one bounded run and streams its
 * text back. The launcher keeps the subscription login and its isolation; this
 * process only translates. A set META_API_KEY refuses the route: these
 * accounts never fall back to API billing.
 *
 * Muse runs are stateless, so a follow-up gets a bounded recap of the earlier
 * turns in this session instead of continuing one Muse conversation. Required
 * context the caller delivered explicitly (embedded skill entry and reference
 * resources) is kept apart from that recap and sent again on every turn.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  buildPromptFile,
  createEventTranslator,
  mergeRequired,
  requiredReceipts,
  splitPrompt,
} from "./muse-acp.logic.mjs";

// The first model is the default. Ids must match the worker launcher's allowlist
// (nofun-skills scripts/muse-worker.sh); Wonder runs on the same subscriptions.
const MODELS = [
  { value: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
  { value: "muse-wonder-1.0-contributor", name: "Muse Wonder Contributor" },
  { value: "muse-wonder-full-1.0-contributor", name: "Muse Wonder Full Contributor" },
];
const PROFILES = [
  { value: "muse-review", name: "Review (read-only)", description: "No writes, no shell." },
  { value: "muse-focused", name: "Focused (writes in place)", description: "Edits the workspace." },
  { value: "muse-build", name: "Build (new worktree)", description: "Starts a fresh worktree." },
  {
    value: "muse-judge",
    name: "Judge (read-only, max)",
    description: "Max effort, no writes, no shell.",
  },
];

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const accountId = flag("--account");
const accountsPath = flag("--accounts") ?? join(homedir(), ".nofun-t3", "muse-accounts.json");
const expandHome = (value) =>
  value === "~" || value?.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

function loadAccount() {
  const file = JSON.parse(readFileSync(accountsPath, "utf8"));
  const account = (file.accounts ?? []).find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`No Muse account "${accountId}" in ${accountsPath}.`);
  return account;
}

/** Mirrors museChildEnvironment in apps/server/src/nofun/museUsage.logic.ts. */
function childEnvironment(account) {
  if (process.env.META_API_KEY?.trim()) {
    throw new Error("META_API_KEY is set; Muse subscription routes refuse API billing.");
  }
  const env = { ...process.env };
  delete env.MUSE_AUTH_PATH;
  delete env.TBH_CREDENTIAL_BACKEND;
  delete env.META_API_KEY;
  if (account.configHome) env.XDG_CONFIG_HOME = expandHome(account.configHome);
  if (account.dataHome) env.XDG_DATA_HOME = expandHome(account.dataHome);
  return env;
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, body) =>
  send({ method: "session/update", params: { sessionId, update: body } });

/** sessionId → { cwd, model, profile, history: [{prompt, answer}], required: Map<uri, entry>, run } */
const sessions = new Map();

const configOptions = (session) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: session.model,
    options: MODELS,
  },
  {
    id: "profile",
    name: "Worker profile",
    description: "What the Muse worker may do. Writers belong in an isolated worktree.",
    type: "select",
    currentValue: session.profile,
    options: PROFILES,
  },
];

function runPrompt(id, params) {
  const session = sessions.get(params.sessionId);
  if (!session) return fail(id, -32602, "Unknown session.");
  if (session.run) return fail(id, -32000, "A Muse run is already in progress for this session.");
  let account;
  let env;
  try {
    account = loadAccount();
    env = childEnvironment(account);
  } catch (error) {
    return fail(id, -32000, error.message);
  }
  const { request: text, required: delivered, problems } = splitPrompt(params.prompt);
  if (problems.length > 0) return fail(id, -32000, problems.join(" "));
  const merged = mergeRequired(session.required, delivered);
  if (merged.error) return fail(id, -32000, merged.error);
  session.required = merged.required;
  const taskId = `t3-${accountId}-${randomUUID().slice(0, 8)}`;
  const dir = join(tmpdir(), "muse-acp", params.sessionId);
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `${taskId}.md`);
  writeFileSync(
    promptFile,
    buildPromptFile({ required: session.required, history: session.history, request: text }),
  );
  const worker = expandHome(account.workerExecutable) ?? "muse-worker.sh";
  const child = spawn(
    worker,
    [
      "--workspace",
      session.cwd,
      "--prompt-file",
      promptFile,
      "--task-id",
      taskId,
      "--profile",
      session.profile,
      "--model",
      session.model,
    ],
    // Its own process group: the launcher pipes `muse exec` through tee, and
    // cancel must stop all of them, not orphan the model run.
    { cwd: session.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const run = { child, cancelled: false, settled: false, answer: "", streamed: "", stderr: "" };
  session.run = run;
  const translator = createEventTranslator();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    for (const action of translator.translate(event)) {
      if (action.type === "delta") {
        run.streamed += action.text;
        update(params.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: action.text },
        });
      } else if (action.type === "final") {
        run.answer = action.text;
      } else {
        update(params.sessionId, action.body);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    run.stderr = (run.stderr + chunk.toString()).slice(-4_000);
  });
  child.on("error", (error) => {
    session.run = null;
    fail(id, -32000, `Could not start the Muse worker: ${error.message}`);
  });
  // A cancelled run answers as soon as the launcher exits; a finished one
  // waits for its output to drain.
  child.on("exit", () => {
    if (run.cancelled && !run.settled) {
      run.settled = true;
      session.run = null;
      reply(id, { stopReason: "cancelled" });
    }
  });
  child.on("close", (code) => {
    if (run.settled) return;
    run.settled = true;
    session.run = null;
    if (run.cancelled) return reply(id, { stopReason: "cancelled" });
    const answer = run.answer || run.streamed;
    // A final text that never streamed still reaches the thread.
    if (!run.streamed && answer) {
      update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: answer },
      });
    }
    if (code !== 0) {
      const detail = run.stderr.trim().split("\n").slice(-3).join(" ");
      return fail(id, -32000, `Muse worker exited with code ${code}. ${detail}`.trim());
    }
    session.history.push({ prompt: text, answer });
    // Receipts say what the prompt carried (identity), never that a model used it.
    const receipts = requiredReceipts(session.required);
    reply(id, {
      stopReason: "end_turn",
      ...(receipts.length > 0 ? { _meta: { museAcp: { requiredContext: receipts } } } : {}),
    });
  });
}

/**
 * Stops the launcher and everything it started: the process group this
 * session created, never a process found by name. SIGKILL follows if the
 * group is still alive after a grace period.
 */
function stopGroup(child) {
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 3_000).unref();
}

function handle(message) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: [],
        agentInfo: { name: "muse-acp", title: `Muse Code · ${accountId}`, version: "1.0.0" },
      });
    case "authenticate":
      return reply(id, {});
    case "session/new": {
      try {
        loadAccount();
      } catch (error) {
        return fail(id, -32000, error.message);
      }
      const sessionId = randomUUID();
      const session = {
        cwd: params.cwd ?? process.cwd(),
        model: MODELS[0].value,
        profile: "muse-review",
        history: [],
        required: new Map(),
        run: null,
      };
      sessions.set(sessionId, session);
      return reply(id, { sessionId, configOptions: configOptions(session) });
    }
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (!session) return fail(id, -32602, "Unknown session.");
      if (params.configId === "profile") {
        if (!PROFILES.some((profile) => profile.value === params.value)) {
          return fail(id, -32602, `Unknown Muse profile: ${params.value}`);
        }
        session.profile = params.value;
      } else if (params.configId === "model") {
        if (!MODELS.some((model) => model.value === params.value)) {
          return fail(id, -32602, `Unknown model: ${params.value}`);
        }
        session.model = params.value;
      }
      return reply(id, { configOptions: configOptions(session) });
    }
    case "session/set_model": {
      const session = sessions.get(params.sessionId);
      if (!session) return fail(id, -32602, "Unknown session.");
      if (!MODELS.some((model) => model.value === params.modelId)) {
        return fail(id, -32602, `Unknown model: ${params.modelId}`);
      }
      session.model = params.modelId;
      return reply(id, {});
    }
    case "session/set_mode":
      return reply(id, {});
    case "session/prompt":
      return runPrompt(id, params);
    case "session/cancel": {
      const run = sessions.get(params.sessionId)?.run;
      if (run) {
        run.cancelled = true;
        stopGroup(run.child);
      }
      return id === undefined ? undefined : reply(id, null);
    }
    case "session/close": {
      const run = sessions.get(params.sessionId)?.run;
      if (run) stopGroup(run.child);
      sessions.delete(params.sessionId);
      return reply(id, {});
    }
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
}

if (!accountId) {
  process.stderr.write("usage: muse-acp.mjs --account <id> [--accounts <path>]\n");
  process.exit(2);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    process.stderr.write(`muse-acp: ${error.message}\n`);
  }
});
process.stdin.on("end", () => {
  for (const session of sessions.values()) if (session.run) stopGroup(session.run.child);
  process.exit(0);
});
