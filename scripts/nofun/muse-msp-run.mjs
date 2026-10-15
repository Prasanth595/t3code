#!/usr/bin/env node
/**
 * Private `muse exec` shim used ONLY inside the configured worker launcher.
 * The launcher still owns profile resolution, account roots and credential
 * backend. MSP runs the useful prompt once; usage/read never submits a turn.
 * Install beside muse-acp.mjs. Never invoke this as a quota probe.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const models = new Set([
  "muse-spark-1.3-contributor",
  "muse-wonder-1.0-contributor",
  "muse-wonder-full-1.0-contributor",
]);
const failure = () => new Error("Muse native useful-run protocol failed.");
// MSP commands require UUIDv7; randomUUID() produces v4.
function commandId() {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 15) | 112;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Project only the documented usage fields, never arbitrary host data. */
export function sanitizeUsage(value, now = Date.now()) {
  const number = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000;
  if (
    !value ||
    !number(value.observedAtMs) ||
    value.observedAtMs > now ||
    !number(value.window?.usedPercent) ||
    !number(value.weekly?.usedPercent) ||
    !number(value.window?.resetsAtMs) ||
    !number(value.weekly?.resetsAtMs) ||
    !number(value.window?.windowDurationMins) ||
    value.window.windowDurationMins === 0 ||
    typeof value.tier !== "string"
  )
    return null;
  return {
    window: {
      usedPercent: value.window.usedPercent,
      resetsAtMs: value.window.resetsAtMs,
      windowDurationMins: value.window.windowDurationMins,
    },
    weekly: { usedPercent: value.weekly.usedPercent, resetsAtMs: value.weekly.resetsAtMs },
    tier: value.tier,
    observedAtMs: value.observedAtMs,
  };
}

function options(argv) {
  if (argv[0] !== "exec" || !argv.includes("--disable-approval") || !argv.includes("--json"))
    throw failure();
  const result = { serve: ["serve", "--provider", "meta", "--no-session-log"], effort: "high" };
  const flags = new Set([
    "--json",
    "--disable-approval",
    "--disable-write",
    "--disable-shell",
    "--trust-workspace",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const name = argv[i];
    if (flags.has(name)) {
      if (["--disable-write", "--disable-shell", "--trust-workspace"].includes(name))
        result.serve.push(name);
      continue;
    }
    const value = argv[++i];
    if (!value) throw failure();
    switch (name) {
      case "--model":
        result.model = value;
        break;
      case "--workspace":
        result.workspace = value;
        break;
      case "--prompt-file":
        result.promptFile = value;
        break;
      case "--reasoning-effort":
        result.effort = value;
        break;
      case "--max-model-steps":
        result.steps = Number(value);
        break;
      case "-w":
        if (value !== "create") throw failure();
        result.worktree = { mode: "create" };
        break;
      // Unknown flags must not silently lose a launcher constraint.
      default:
        throw failure();
    }
  }
  if (
    !models.has(result.model) ||
    !result.workspace?.startsWith("/") ||
    !result.promptFile?.startsWith("/") ||
    !["high", "xhigh", "max"].includes(result.effort) ||
    !Number.isSafeInteger(result.steps) ||
    result.steps < 1
  )
    throw failure();
  result.serve.push("--model", result.model);
  return result;
}

/** One useful run, with a real stdio subprocess and no fallback to `exec`. */
export async function runMsp({ executable, argv, env, expectedLogin, emit }) {
  let child;
  try {
    if (env.META_API_KEY?.trim() || !expectedLogin?.trim() || !executable?.startsWith("/"))
      throw failure();
    const opts = options(argv);
    const prompt = readFileSync(opts.promptFile, "utf8");
    if (!prompt.trim()) throw failure();
    child = spawn(executable, opts.serve, {
      cwd: opts.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Same process group as the worker launcher: ACP cancellation owns all of it.
    child.stderr.resume(); // Do not copy host diagnostics into T3 or persisted usage.
    const pending = new Map();
    let nextId = 1,
      sessionId,
      turnId,
      started = false,
      identity,
      identityFailed = false;
    let usage = null,
      steps = 0,
      limitHit = false;
    const items = new Map();
    const streamedItems = new Set();
    const seenCursors = new Set();
    let complete, abort;
    const terminal = new Promise((resolve, reject) => {
      complete = resolve;
      abort = reject;
    });
    // Handshake failures can arrive before the terminal await.
    terminal.catch(() => {});
    const send = (message) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    const request = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(failure());
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    const rejectAll = () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(failure());
      }
      pending.clear();
      abort(failure());
    };
    child.on("error", rejectAll);
    child.on("exit", rejectAll);
    child.stdin.on("error", rejectAll);
    const validIdentity = (v) =>
      v?.state === "accountLogin" &&
      typeof v.label === "string" &&
      v.label.trim().toLowerCase() === expectedLogin.trim().toLowerCase();
    const interrupt = () =>
      request("turn/interrupt", {
        commandId: commandId(),
        sessionId,
        ...(turnId ? { turnId } : {}),
      }).catch(() => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method === undefined && pending.has(message.id)) {
          const p = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(p.timer);
          if (message.error) p.reject(failure());
          else p.resolve(message.result);
          return;
        }
        const p = message.params ?? {};
        if (message.method === "account/changed") {
          if (!validIdentity(p)) {
            identityFailed = true;
            usage = null;
            abort(failure());
          }
          return;
        }
        if (message.method === "usage/changed") {
          const observed = sanitizeUsage(p);
          if (
            started &&
            !identityFailed &&
            observed &&
            (!usage || observed.observedAtMs > usage.observedAtMs)
          )
            usage = observed;
          return;
        }
        if (!message.method || p.sessionId !== sessionId) return;
        if (typeof p.viewCursor === "string" && p.viewCursor) {
          if (seenCursors.has(p.viewCursor)) return;
          seenCursors.add(p.viewCursor);
        }
        if (message.id !== undefined) {
          // No unhandled interactive approval/user-input hangs.
          send({ id: message.id, error: { code: -32601, message: "Non-interactive worker." } });
          abort(failure());
          return;
        }
        if (
          message.method === "session/tokenUsage" &&
          started &&
          ++steps >= opts.steps &&
          !limitHit
        ) {
          limitHit = true;
          void interrupt();
        }
        if (
          message.method === "item/delta" &&
          typeof p.delta === "string" &&
          (!p.field || p.field === "text") &&
          items.get(p.itemId)?.kind === "agentMessage"
        ) {
          streamedItems.add(p.itemId);
          const item = items.get(p.itemId);
          items.set(p.itemId, { ...item, text: (item.text ?? "") + p.delta });
          emit({ payload_type: "run.output.delta", payload: { text: p.delta } });
        }
        if (
          message.method === "item/started" ||
          message.method === "item/updated" ||
          message.method === "item/completed"
        ) {
          const item = p.item;
          if (!item || typeof item.itemId !== "string") return;
          const prior = items.get(item.itemId);
          if (prior && Number.isInteger(item.revision) && item.revision <= prior.revision) return;
          items.set(item.itemId, item);
          if (
            item.kind === "agentMessage" &&
            message.method === "item/completed" &&
            typeof item.text === "string"
          ) {
            // Authoritative item text includes any deltas that may have been missed.
            items.set(item.itemId, { ...item, finalText: item.text });
            if (!streamedItems.has(item.itemId))
              emit({ payload_type: "run.output.delta", payload: { text: item.text } });
          }
          if (item.kind === "toolCall" && !prior)
            emit({
              payload_type: "task.lifecycle.proposed",
              payload: {
                task_id: item.itemId,
                event: {
                  task_kind: `tool.${/^[A-Za-z0-9_.:-]{1,48}$/.test(item.tool) ? item.tool : "native"}`,
                },
              },
            });
          if (item.kind === "toolCall") {
            if (typeof item.callId === "string")
              emit({
                payload_type: "task.lifecycle.scheduled",
                payload: {
                  task_id: item.itemId,
                  event: { idempotency_key: `tool:${item.callId}` },
                },
              });
            emit({
              payload_type: `task.lifecycle.${item.status === "inProgress" ? "started" : item.status === "completed" ? "completed" : "failed"}`,
              payload: { task_id: item.itemId, event: {} },
            });
            if (item.status !== "inProgress" && typeof item.callId === "string")
              emit({
                payload_type: "tool.result",
                payload: {
                  call_id: item.callId,
                  correlation_facts: {
                    tool_name: item.tool,
                    outcome:
                      item.status === "completed"
                        ? "success"
                        : item.status === "cancelled"
                          ? "cancelled"
                          : "failure",
                  },
                },
              });
          }
        }
        if (message.method === "turn/completed" && (!turnId || p.turnId === turnId))
          complete(p.terminal);
      } catch {
        abort(failure());
      }
    });
    try {
      await request("initialize", {
        clientInfo: { name: "t3_muse_worker", version: "1" },
        capabilities: { experimentalApi: true, userInputDialogs: false },
      });
      send({ method: "initialized" });
      identity = await request("account/read");
      if (!validIdentity(identity)) throw failure();
      const start = await request("session/start", {
        commandId: commandId(),
        workspaceRoot: opts.workspace,
        modelId: opts.model,
        approvalMode: "allowAll",
        ...(opts.worktree ? { worktree: opts.worktree } : {}),
      });
      sessionId = start.session?.sessionId;
      if (!sessionId) throw failure();
      // A successful empty read is truthful absence; it never starts a probe.
      await request("usage/read");
      started = true;
      const ack = await request("turn/start", {
        commandId: commandId(),
        sessionId,
        input: [{ type: "text", text: prompt }],
        reasoningEffort: opts.effort,
      });
      if (ack.status !== "accepted" || ack.disposition !== "started") throw failure();
      turnId = ack.turnId;
      const outcome = await terminal;
      // Capture stamp-only updates too: usage/changed intentionally omits those.
      const latest = await request("usage/read");
      const observed = sanitizeUsage(latest?.usage);
      if (observed && (!usage || observed.observedAtMs > usage.observedAtMs)) usage = observed;
      const endIdentity = await request("account/read");
      if (identityFailed || !validIdentity(endIdentity)) throw failure();
      if (usage)
        emit({ payload_type: "t3.muse.usage", payload: { usage, signedInAs: identity.label } });
      const answer = [...items.values()]
        .filter((i) => i.kind === "agentMessage")
        .map((i) => i.finalText ?? i.text ?? "")
        .join("\n");
      if (outcome !== "completed" || limitHit) return 1;
      emit({
        payload_type: "run.terminal.completed",
        payload: { terminal: "completed", text: answer },
      });
      return 0;
    } finally {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(failure());
      }
      pending.clear();
    }
  } catch {
    return 1;
  } finally {
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await runMsp({
    executable: process.env.NOFUN_MUSE_NATIVE_CLI,
    expectedLogin: process.env.NOFUN_MUSE_EXPECTED_LOGIN,
    argv: process.argv.slice(2),
    env: process.env,
    emit: (event) => process.stdout.write(JSON.stringify({ id: randomUUID(), ...event }) + "\n"),
  });
  if (code)
    process.stderr.write("Muse native useful-run failed; no raw protocol details retained.\n");
  process.exitCode = code;
}
