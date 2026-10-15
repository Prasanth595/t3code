import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runMsp } from "./muse-msp-run.mjs";

// Protocol fixture derived from the owner's offline CLI schema export. No
// inference, account, network, or credentials are used by these subprocesses.
const fakeHost = `#!/usr/bin/env node
const log = process.env.MSP_LOG;
const { appendFileSync } = await import('node:fs');
const { createInterface } = await import('node:readline');
if(process.env.MSP_LAUNCH) appendFileSync(process.env.MSP_LAUNCH,JSON.stringify({argv:process.argv.slice(2),config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,backend:process.env.TBH_CREDENTIAL_BACKEND}));
let initialized = false;
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); appendFileSync(log, JSON.stringify(m)+'\\n');
 if(m.method==='initialize') return send({id:m.id,result:{}});
 if(m.method==='initialized') {initialized=true;return;}
 if(!initialized) return send({id:m.id,error:{code:-1}});
 if(m.method==='account/read') return send({id:m.id,result:{state:process.env.MSP_STATE??'accountLogin',label:process.env.MSP_LOGIN??'owner@example.test',credentialRequired:true}});
 if(m.method==='session/start') return send({id:m.id,result:{session:{sessionId:'s'},viewCursor:''}});
 if(m.method==='turn/interrupt') return send({id:m.id,result:{status:'accepted'}});
 if(m.method==='usage/read') return send({id:m.id,result:{}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{status:'accepted',turnId:'t',disposition:'started',startedNewTurn:true}});
  if(process.env.MSP_LIMIT) for(let n=0;n<80;n++) send({method:'session/tokenUsage',params:{sessionId:'s',viewCursor:'token-'+n}});
  if(process.env.MSP_CHANGE) send({method:'account/changed',params:{state:'accountLogin',label:'other@example.test'}});
  const usage={window:{usedPercent:0,resetsAtMs:Date.now()+100000,windowDurationMins:300},weekly:{usedPercent:100,resetsAtMs:Date.now()+200000},tier:'pro',observedAtMs:Date.now()};
  if(!process.env.MSP_ABSENT) send({method:'usage/changed',params:{...usage,SENTINEL_SECRET:'do not retain'}});
  send({method:'item/started',params:{sessionId:'s',item:{itemId:'a',kind:'agentMessage',status:'inProgress',revision:0}}});
  send({method:'item/delta',params:{sessionId:'s',itemId:'a',delta:'useful answer'}});
  send({method:'item/completed',params:{sessionId:'s',item:{itemId:'a',kind:'agentMessage',status:'completed',revision:1,text:'useful answer'}}});
  send({method:'turn/completed',params:{sessionId:'s',turnId:'t',terminal:'completed'}});
 }
});`;

async function fixture(options = {}) {
  const { extraArgs = [], ...hostEnv } = options;
  const dir = mkdtempSync(join(tmpdir(), "msp-fixture-"));
  try {
    const cli = join(dir, "muse");
    writeFileSync(cli, fakeHost, { mode: 0o700 });
    const prompt = join(dir, "prompt");
    writeFileSync(prompt, "Review the supplied implementation.");
    const log = join(dir, "calls");
    const events = [];
    const result = await runMsp({
      executable: cli,
      argv: [
        "exec",
        "--model",
        "muse-spark-1.3-contributor",
        "--workspace",
        dir,
        "--prompt-file",
        prompt,
        "--max-model-steps",
        "80",
        "--reasoning-effort",
        "high",
        "--disable-approval",
        "--disable-write",
        "--disable-shell",
        "--json",
        ...extraArgs,
      ],
      env: { ...process.env, META_API_KEY: "", MSP_LOG: log, ...hostEnv },
      expectedLogin: "owner@example.test",
      emit: (event) => events.push(event),
    });
    return {
      result,
      events,
      calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("useful work uses initialized, account identity, pinned model and no-shell posture; usage is sanitized", async () => {
  const { result, events, calls } = await fixture();
  assert.equal(result, 0);
  assert.deepEqual(
    calls.slice(0, 4).map((m) => m.method),
    ["initialize", "initialized", "account/read", "session/start"],
  );
  assert.match(calls[0].params.clientInfo.name, /^[a-z0-9_]+$/);
  const start = calls.find((m) => m.method === "session/start").params;
  assert.equal(start.modelId, "muse-spark-1.3-contributor");
  assert.equal(start.approvalMode, "allowAll");
  assert.equal(calls.filter((m) => m.method === "turn/start").length, 1);
  assert.equal(
    calls.find((m) => m.method === "turn/start").params.input[0].text,
    "Review the supplied implementation.",
  );
  const observed = events.find((e) => e.payload_type === "t3.muse.usage").payload;
  assert.equal(observed.signedInAs, "owner@example.test");
  assert.equal(observed.usage.window.usedPercent, 0);
  assert.equal(observed.usage.weekly.usedPercent, 100);
  assert.ok(!JSON.stringify(observed).includes("SENTINEL"));
  assert.equal(
    events.find((e) => e.payload_type === "run.terminal.completed").payload.text,
    "useful answer",
  );
});

test("absent last-observed data never becomes a made-up reading or an extra turn", async () => {
  const { events, calls, result } = await fixture({ MSP_ABSENT: "1" });
  assert.equal(result, 0);
  assert.ok(!events.some((e) => e.payload_type === "t3.muse.usage"));
  assert.equal(calls.filter((m) => m.method === "turn/start").length, 1);
});

test("wrong login or API billing lane stops before useful inference", async () => {
  for (const opts of [{ MSP_LOGIN: "wrong@example.test" }, { MSP_STATE: "envKey" }]) {
    const { result, calls, events } = await fixture(opts);
    assert.equal(result, 1);
    assert.ok(!calls.some((m) => m.method === "turn/start"));
    assert.ok(!events.some((e) => e.payload_type === "t3.muse.usage"));
  }
});

test("identity drift discards usage instead of binding it to the old account", async () => {
  const { events, result } = await fixture({ MSP_CHANGE: "1" });
  assert.equal(result, 1);
  assert.ok(!events.some((e) => e.payload_type === "t3.muse.usage"));
});

test("ACP keeps the account launcher, passes required context, and atomically saves only bound usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msp-acp-fixture-"));
  let bridge;
  try {
    const cli = join(dir, "native-muse");
    writeFileSync(cli, fakeHost, { mode: 0o700 });
    // Stand-in for the configured support launcher: it pins its own roots and
    // credential backend, then runs the same muse exec flags as muse-worker.sh.
    const worker = join(dir, "worker");
    writeFileSync(
      worker,
      `#!/bin/bash
export XDG_CONFIG_HOME="${dir}/pinned-config"
export XDG_DATA_HOME="${dir}/pinned-data"
export TBH_CREDENTIAL_BACKEND=file
while [ "$#" -gt 0 ]; do
 case "$1" in
 --workspace) workspace="$2"; shift 2;;
 --prompt-file) prompt="$2"; shift 2;;
 --model) model="$2"; shift 2;;
 --profile) profile="$2"; shift 2;;
 *) shift 2;;
 esac
done
exec muse exec --workspace "$workspace" --prompt-file "$prompt" --model "$model" --reasoning-effort high --max-model-steps 80 --disable-approval --json --disable-write --disable-shell
`,
      { mode: 0o700 },
    );
    const registry = join(dir, "accounts.json");
    writeFileSync(
      registry,
      JSON.stringify({
        persona: "nofun",
        accounts: [
          {
            id: "fixture",
            label: "Muse Fixture",
            expectedEmail: "owner@example.test",
            cliExecutable: cli,
            workerExecutable: worker,
          },
        ],
      }),
    );
    const launch = join(dir, "launch");
    bridge = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./muse-acp.mjs", import.meta.url)),
        "--account",
        "fixture",
        "--accounts",
        registry,
      ],
      {
        env: { ...process.env, META_API_KEY: "", MSP_LOG: join(dir, "calls"), MSP_LAUNCH: launch },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    bridge.stderr.resume();
    const pending = new Map();
    const notes = [];
    let id = 0;
    createInterface({ input: bridge.stdout }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else notes.push(m);
    });
    const request = (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      });
    const session = (await request("session/new", { cwd: dir })).result.sessionId;
    const result = await request("session/prompt", {
      sessionId: session,
      prompt: [
        { type: "text", text: "Review the implementation; explain its cancellation behavior." },
        {
          type: "resource",
          resource: {
            uri: "skill://fixture/reference.md",
            mimeType: "text/plain",
            text: "Required fact: cancellation owns the spawned process group.",
          },
        },
      ],
    });
    assert.equal(result.result.stopReason, "end_turn");
    const kept = JSON.parse(
      readFileSync(
        join(dir, "muse-usage-observations", readdirSync(join(dir, "muse-usage-observations"))[0]),
        "utf8",
      ),
    );
    assert.equal(kept.accountId, "fixture");
    assert.equal(kept.sourceId, "muse:fixture");
    assert.match(kept.accountBinding, /^[a-f0-9]{64}$/);
    assert.equal(kept.cost, "passive");
    assert.equal(kept.usage.window.usedPercent, 0);
    assert.equal(kept.usage.weekly.usedPercent, 100);
    assert.ok(!JSON.stringify(kept).includes(dir));
    assert.ok(!JSON.stringify(kept).includes("SENTINEL"));
    const native = JSON.parse(readFileSync(launch, "utf8"));
    assert.ok(native.argv.includes("--disable-shell"));
    assert.ok(native.argv.includes("--disable-write"));
    assert.ok(native.argv.includes("--no-session-log"));
    assert.ok(!native.argv.includes("--disable-sandbox"));
    assert.equal(native.config, join(dir, "pinned-config"));
    assert.equal(native.data, join(dir, "pinned-data"));
    assert.equal(native.backend, "file");
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.match(
      calls.find((m) => m.method === "turn/start").params.input[0].text,
      /Required fact: cancellation owns the spawned process group/,
    );
    assert.ok(notes.some((m) => m.params?.update?.sessionUpdate === "agent_message_chunk"));
  } finally {
    if (bridge) {
      const closed = new Promise((resolve) => bridge.once("close", resolve));
      bridge.stdin.end();
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native completion guard interrupts at the launcher's step bound and does not claim success", async () => {
  const { result, calls, events } = await fixture({ MSP_LIMIT: "1" });
  assert.equal(result, 1);
  assert.ok(calls.some((m) => m.method === "turn/interrupt"));
  assert.ok(!events.some((e) => e.payload_type === "run.terminal.completed"));
});

test("an unknown launcher constraint refuses the run instead of dropping the flag", async () => {
  const { result, calls } = await fixture({ extraArgs: ["--disable-sandbox"] });
  assert.equal(result, 1);
  assert.deepEqual(calls, []);
});
