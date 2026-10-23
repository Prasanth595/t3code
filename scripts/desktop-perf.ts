// Desktop performance harness for a packaged (release) build.
//
//   node scripts/desktop-perf.ts [--app <T3 Code.app>] [--baseline <results.json>] [--deep]
//
// Without --app it builds the current tree with build-desktop-artifact (`--target dir`).
// It seeds a scratch HOME once (a ~100,000 message chat plus three chats that
// stream from a synthetic ACP agent), launches the app against copies of it with
// Chromium remote debugging, drives each scene, and writes results.json plus a
// before/after table when --baseline is given. --deep adds xctrace, sample,
// vmmap and footprint captures. Nothing touches ~/.t3 or the real app's data.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

const sleep = NodeTimersPromises.setTimeout;
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const LONG_TURNS = 50_000; // two messages per turn
const STREAM_TITLES = ["Stream A", "Stream B", "Stream C"];
const LONG_TITLE = "Long chat";

// Budgets each scene must meet. Frame budgets apply to the five longest
// renderer main-thread tasks, which bound the slowest frames in the scene.
const BUDGETS: Record<string, Record<string, number>> = {
  launch: { usableMs: 2500, slowestFrameMs: 16 },
  firstOpenLongChat: { openMs: 1000, slowestFrameMs: 16 },
  openLongChat: { openMs: 300, liveMs: 1000, slowestFrameMs: 16 },
  scrollLongChat: { slowestFrameMs: 16 },
  streaming: { rendererCpuPct: 25, slowestFrameMs: 16 },
  backgroundStreaming: { framesPerSec: 1, slowestFrameMs: 16 },
  idle: { appCpuPct: 0.5, framesPerSec: 0.2, slowestFrameMs: 16 },
  switching: { switchMs: 150, slowestFrameMs: 16 },
  operating: { inputToPaintMs: 50, slowestFrameMs: 16 },
};

// Synthetic ACP agent. T3 Code spawns it as a local `acpRegistry` provider.
// A prompt containing `stream <seconds>` streams markdown at 200 chunks per
// second for that long; any other prompt gets one short markdown reply.

function fakeAgent(): void {
  const send = (message: Record<string, unknown>) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const update = (sessionId: string, value: Record<string, unknown>) =>
    send({ method: "session/update", params: { sessionId, update: value } });
  const words = "the quick agent reads files plans edits runs tests and reports results".split(" ");
  const reply = [
    "## Summary",
    "",
    "The agent read `src/app.ts`, updated **two** handlers and ran the suite.",
    "",
    "- Parsed the request and planned the change",
    "- Edited the router and its tests",
    "- All 42 tests pass",
    "",
    "```ts",
    "export function handle(request: Request): Response {",
    "  return new Response(request.url);",
    "}",
    "```",
  ].join("\n");
  const running = new Map<string, () => void>();

  const prompt = (id: unknown, sessionId: string, text: string) => {
    const messageId = `fake-message-${NodeCrypto.randomUUID()}`;
    const chunk = (value: string) =>
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: value },
      });
    const finish = (stopReason: string) => {
      running.delete(sessionId);
      update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason });
      send({ id, result: { stopReason } });
    };
    const seconds = Number(/stream (\d+)/.exec(text)?.[1] ?? 0);
    if (seconds <= 0) {
      chunk(reply);
      finish("end_turn");
      return;
    }
    let sent = 0;
    const total = seconds * 200;
    const timer = setInterval(() => {
      sent += 1;
      const word = words[sent % words.length];
      chunk(
        sent % 40 === 0
          ? `${word}.\n\n`
          : sent % 400 === 1
            ? `\n\n## Step ${sent} ${word}`
            : ` ${word}`,
      );
      if (sent >= total) {
        clearInterval(timer);
        finish("end_turn");
      }
    }, 5);
    running.set(sessionId, () => {
      clearInterval(timer);
      finish("cancelled");
    });
  };

  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (message.method === undefined) return;
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        send({
          id: message.id,
          result: {
            protocolVersion: 2,
            info: { name: "t3-fake-agent", version: "1.0.0" },
            capabilities: { session: {} },
          },
        });
        return;
      case "session/new":
        send({
          id: message.id,
          result: {
            sessionId: `fake-session-${NodeCrypto.randomUUID()}`,
            configOptions: [
              {
                configId: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: "fake",
                options: [{ value: "fake", name: "Fake synthetic model" }],
              },
            ],
          },
        });
        return;
      case "session/prompt": {
        const blocks = (params.prompt ?? []) as Array<{ text?: string }>;
        prompt(
          message.id,
          String(params.sessionId),
          blocks.map((block) => block.text ?? "").join(" "),
        );
        return;
      }
      case "session/cancel":
        running.get(String(params.sessionId))?.();
        return;
      default:
        if (message.id !== undefined) send({ id: message.id, result: {} });
    }
  });
}

const log = (message: string) => process.stderr.write(`[desktop-perf] ${message}\n`);
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileSyncOptions = {},
) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...options,
  }) as string;

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly cpuSeconds: number;
  readonly command: string;
}

const parseCpuTime = (value: string) =>
  value.split(":").reduce((total, part) => total * 60 + Number(part), 0);

function processTree(rootPid: number): Array<ProcessRow & { role: string }> {
  const rows = run("ps", ["-A", "-o", "pid=,ppid=,time=,command="])
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              cpuSeconds: parseCpuTime(match[3]!),
              command: match[4]!,
            },
          ]
        : [];
    });
  const pids = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!pids.has(row.pid) && pids.has(row.ppid)) {
        pids.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((row) => pids.has(row.pid))
    .map((row) => ({ ...row, role: processRole(row, rootPid) }));
}

function processRole(row: ProcessRow, rootPid: number): string {
  if (row.pid === rootPid) return "main";
  if (row.command.includes("desktop-perf.ts fake-agent")) return "fake-agent";
  if (row.command.includes("--type=renderer")) return "renderer";
  if (row.command.includes("--type=gpu-process")) return "gpu";
  if (row.command.includes("--type=utility")) return "utility";
  if (row.command.includes("--bootstrap-fd")) return "server";
  if (row.command.includes("resource-monitor")) return "resource-monitor";
  return "other";
}

const appRoles = (tree: ReturnType<typeof processTree>) =>
  tree.filter((row) => row.role !== "fake-agent");

function cpuByRole(
  before: ReturnType<typeof processTree>,
  after: ReturnType<typeof processTree>,
  seconds: number,
) {
  const start = new Map(before.map((row) => [row.pid, row.cpuSeconds]));
  const result: Record<string, number> = {};
  for (const row of appRoles(after)) {
    const delta = row.cpuSeconds - (start.get(row.pid) ?? 0);
    result[row.role] = (result[row.role] ?? 0) + (delta / seconds) * 100;
  }
  result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(result).map(([role, value]) => [role, round(value, 2)]));
}

// phys_footprint per role in MB, the number Activity Monitor reports as Memory.
function footprintByRole(rootPid: number) {
  const tree = appRoles(processTree(rootPid));
  const file = NodePath.join(NodeOS.tmpdir(), `t3-footprint-${process.pid}.json`);
  run(
    "footprint",
    [
      "--noCategories",
      "-f",
      "bytes",
      "-j",
      file,
      ...tree.flatMap((row) => ["-p", String(row.pid)]),
    ],
    {
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const json = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    processes: Array<{ pid: number; footprint: number }>;
  };
  NodeFS.rmSync(file, { force: true });
  const result: Record<string, number> = {};
  for (const entry of json.processes) {
    const role = tree.find((row) => row.pid === entry.pid)?.role ?? "other";
    result[role] = (result[role] ?? 0) + entry.footprint / 1e6;
  }
  result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(result).map(([role, value]) => [role, round(value)]));
}

// Wakeups per second for each role: the kernel's interrupt wakeup counter
// (proc_pid_rusage ri_interrupt_wkups). top's IDLEW only counts wakeups from
// package idle, which reads 0 on a machine that is never idle.
const WAKEUPS = `
import ctypes, json, sys, time
libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
def wakeups(pid):
    info = (ctypes.c_uint64 * 40)()
    return info[5] if libproc.proc_pid_rusage(int(pid), 2, info) == 0 else 0
pids = sys.argv[2:]
start = {pid: wakeups(pid) for pid in pids}
time.sleep(float(sys.argv[1]))
print(json.dumps({pid: wakeups(pid) - start[pid] for pid in pids}))
`;

function wakeupsByRole(rootPid: number, seconds: number) {
  const tree = appRoles(processTree(rootPid));
  const deltas = JSON.parse(
    run("python3", ["-c", WAKEUPS, String(seconds), ...tree.map((row) => String(row.pid))]),
  ) as Record<string, number>;
  const result: Record<string, number> = {};
  for (const row of tree)
    result[row.role] = (result[row.role] ?? 0) + (deltas[row.pid] ?? 0) / seconds;
  result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(result).map(([role, value]) => [role, round(value)]));
}

class Cdp {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    (message: { result?: any; error?: unknown }) => void
  >();
  private readonly listeners = new Map<string, Array<(params: any) => void>>();
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    const reply = await new Promise<{ result?: any; error?: unknown }>((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  on(method: string, listener: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    return () =>
      this.listeners.set(
        method,
        (this.listeners.get(method) ?? []).filter((entry) => entry !== listener),
      );
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(`eval failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value as T;
  }

  async waitFor(expression: string, timeoutMs = 30_000, intervalMs = 16): Promise<number> {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (await this.eval<boolean>(expression).catch(() => false)) return performance.now();
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }

  async key(key: string, options: { meta?: boolean; code?: string; keyCode?: number } = {}) {
    const modifiers = options.meta ? 4 : 0;
    const code = options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
    const keyCode = options.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const text = !options.meta && key.length === 1 ? key : key === "Enter" ? "\r" : undefined;
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      ...(text ? { text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
    });
  }

  async click(selectorExpression: string) {
    const point = await this.eval<{ x: number; y: number } | null>(`(() => {
      const element = ${selectorExpression};
      if (!element) return null;
      element.scrollIntoView({ block: "nearest" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`nothing to click: ${selectorExpression}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  }

  close() {
    this.socket.close();
  }
}

const threadRow = (title: string) =>
  `[...document.querySelectorAll("[data-thread-item]")].find((element) => element.innerText.includes(${JSON.stringify(title)}))`;
const COMPOSER = `document.querySelector("[contenteditable=true]")`;
const sidebarButton = (label: string) =>
  `[...document.querySelectorAll("button, a")].find((element) => element.innerText?.trim() === ${JSON.stringify(label)} || element.getAttribute("aria-label") === ${JSON.stringify(label)})`;

async function sendPrompt(cdp: Cdp, text: string) {
  await cdp.eval(`${COMPOSER}.focus()`);
  await cdp.send("Input.insertText", { text });
  await sleep(100);
  await cdp.key("Enter", { code: "Enter", keyCode: 13 });
}

interface RunningApp {
  readonly child: NodeChildProcess.ChildProcess;
  readonly port: number;
  readonly spawnedAt: number;
  readonly cdp: Cdp;
  readonly pageAt: number;
}

function appExecutable(app: string) {
  const macos = NodePath.join(app, "Contents/MacOS");
  return NodePath.join(macos, NodeFS.readdirSync(macos)[0]!);
}

async function launch(app: string, home: string, port: number): Promise<RunningApp> {
  const spawnedAt = performance.now();
  // A scratch HOME has no login keychain; without the mock keychain Electron's
  // safeStorage blocks the main thread on a macOS keychain dialog.
  // The main-process inspector drives native window state, which page CDP cannot.
  const child = NodeChildProcess.spawn(
    appExecutable(app),
    [`--remote-debugging-port=${port}`, `--inspect=${port + 1000}`, "--use-mock-keychain"],
    {
      cwd: home,
      env: { ...process.env, HOME: home, T3CODE_DISABLE_AUTO_UPDATE: "1" },
      stdio: [
        "ignore",
        NodeFS.openSync(NodePath.join(home, "app.log"), "a"),
        NodeFS.openSync(NodePath.join(home, "app.log"), "a"),
      ],
    },
  );
  for (;;) {
    if (child.exitCode !== null) throw new Error(`app exited early, see ${home}/app.log`);
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .catch(() => [])) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;
    const page = targets.find(
      (target) => target.type === "page" && target.url.startsWith("t3code://"),
    );
    if (page) {
      const pageAt = performance.now();
      return { child, port, spawnedAt, pageAt, cdp: await Cdp.connect(page.webSocketDebuggerUrl) };
    }
    if (performance.now() - spawnedAt > 60_000) throw new Error("no page target after 60s");
    await sleep(25);
  }
}

async function quit(app: RunningApp) {
  app.cdp.close();
  app.child.kill("SIGTERM");
  const exited = new Promise((resolve) => app.child.once("exit", resolve));
  if (
    app.child.exitCode === null &&
    (await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])) === false
  ) {
    app.child.kill("SIGKILL");
    await exited;
  }
}

// APFS clones make each run start from an identical, untouched home.
function freshHome(template: string, destination: string) {
  NodeFS.rmSync(destination, { recursive: true, force: true });
  run("cp", ["-c", "-R", template, destination]);
  const settings = NodePath.join(destination, ".t3/userdata/settings.json");
  NodeFS.writeFileSync(
    settings,
    NodeFS.readFileSync(settings, "utf8").replaceAll(template, destination),
  );
  return destination;
}

async function seed(app: string, home: string) {
  NodeFS.rmSync(home, { recursive: true, force: true });
  const project = NodePath.join(home, "work/demo");
  NodeFS.mkdirSync(NodePath.join(home, ".t3/userdata"), { recursive: true });
  NodeFS.mkdirSync(project, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# demo\n");
  const git = (...args: string[]) =>
    run("git", ["-c", "user.email=perf@t3.codes", "-c", "user.name=perf", ...args], {
      cwd: project,
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  NodeFS.writeFileSync(
    NodePath.join(home, ".t3/userdata/settings.json"),
    JSON.stringify({
      // Only the synthetic agent runs: built-in providers would launch the
      // real codex/claude/... CLIs on PATH, and title generation would call
      // a real model (the fake instance does not support it, so it no-ops).
      textGenerationModelSelection: { instanceId: "fake", model: "default" },
      providerInstances: {
        ...Object.fromEntries(
          ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "pi", "muse"].map(
            (driver) => [driver, { driver, enabled: false }],
          ),
        ),
        fake: {
          driver: "acpRegistry",
          displayName: "Fake",
          enabled: true,
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [NodePath.join(repoRoot, "scripts/desktop-perf.ts"), "fake-agent"],
          },
        },
      },
    }),
  );
  const serverEntry = NodePath.join(app, "Contents/Resources/app.asar/apps/server/dist/bin.mjs");
  run(
    appExecutable(app),
    [serverEntry, "project", "add", project, "--base-dir", NodePath.join(home, ".t3")],
    {
      env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: "1" },
    },
  );

  const session = await launch(app, home, 9341);
  try {
    await seedThreads(session.cdp, NodePath.join(home, ".t3/userdata/statev2.sqlite"));
  } finally {
    await quit(session);
  }
  log("cloning the long chat to 100,000 messages");
  cloneLongChat(NodePath.join(home, ".t3/userdata/statev2.sqlite"));
  // The server compacts superseded history a minute after start; do it now with
  // the app's own maintenance (which also verifies the projections) so it does
  // not land inside a measured scene.
  log("compacting with `t3 doctor --fix`");
  run(
    appExecutable(app),
    [serverEntry, "doctor", "--fix", "--base-dir", NodePath.join(home, ".t3")],
    {
      env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
}

// A copy of the template after one ordinary ~2 minute session of this app, so
// measurements start where a returning user's would: the open-time PRAGMA
// optimize has analyzed the grown tables and startup maintenance has run.
// Otherwise every measured launch re-analyzes 1.5M rows from a cold cache.
async function warmedHome(app: string, template: string, out: string) {
  const asar = NodeFS.statSync(NodePath.join(app, "Contents/Resources/app.asar"));
  const key = NodeCrypto.createHash("sha1")
    .update(`${NodeFS.realpathSync(app)}:${asar.size}:${asar.mtimeMs}`)
    .digest("hex")
    .slice(0, 10);
  const home = NodePath.join(out, `home-warm-${key}`);
  if (NodeFS.existsSync(NodePath.join(home, ".warmed"))) return home;
  log(`warming ${home}: open each chat, then wait out startup maintenance`);
  freshHome(template, home);
  const session = await launch(app, home, 9341);
  try {
    await session.cdp.waitFor(
      `!!${COMPOSER} && document.querySelectorAll("[data-thread-item]").length >= 4`,
      180_000,
      100,
    );
    // A returning user's client cache already holds the chats they open.
    for (const title of [LONG_TITLE, ...STREAM_TITLES]) await openThread(session.cdp, title);
    await sleep(110_000);
  } finally {
    await quit(session);
  }
  NodeFS.writeFileSync(NodePath.join(home, ".warmed"), "");
  return home;
}

async function seedThreads(cdp: Cdp, databasePath: string) {
  await cdp.waitFor(`!!${COMPOSER}`);
  let replies = 0;
  const turn = async (text: string) => {
    await sendPrompt(cdp, text);
    replies += 1;
    // Wait for the server to persist the finished reply and its checkpoint.
    for (const started = performance.now(); ; await sleep(200)) {
      const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      const done = db
        .prepare(
          `SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE status = 'completed'`,
        )
        .get() as { n: number };
      db.close();
      if (done.n >= replies) break;
      if (performance.now() - started > 60_000) throw new Error(`no reply to ${text}`);
    }
    await sleep(500);
  };
  for (const title of [LONG_TITLE, ...STREAM_TITLES]) {
    if (title !== LONG_TITLE) {
      await cdp.key("n", { meta: true });
      await sleep(800);
    }
    await turn(title);
    if (title === LONG_TITLE) await turn("Long chat turn 2");
  }
}

// Clones the long chat's second turn (its events and every projection row) so
// the chat holds LONG_TURNS turns, exactly as if they had run. Identifiers that
// first appear in that turn get fresh values per clone; ordinals advance; times
// spread 20 s apart ending now.
function cloneLongChat(databasePath: string) {
  const db = new NodeSqlite.DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
  const all = (sql: string, ...params: Array<string | number>) =>
    db.prepare(sql).all(...params) as Array<Record<string, any>>;
  const threadId = all(
    `SELECT thread_id FROM orchestration_v2_projection_threads WHERE title = ?`,
    LONG_TITLE,
  )[0]!.thread_id as string;
  const run2 = `run:thread:${threadId}:ordinal:2`;
  const runCreated = all(
    `SELECT command_id FROM orchestration_events WHERE stream_id = ? AND event_type = 'run.created' AND json_extract(metadata_json, '$.runId') = ?`,
    threadId,
    run2,
  )[0]!;
  const start = all(
    `SELECT min(sequence) AS s FROM orchestration_events WHERE command_id = ?`,
    runCreated.command_id,
  )[0]!.s as number;
  const templateEvents = all(
    `SELECT * FROM orchestration_events WHERE stream_id = ? AND sequence >= ? AND event_type NOT IN ('thread.visited', 'thread.metadata-updated') ORDER BY sequence`,
    threadId,
    start,
  );
  const earlier = JSON.stringify(
    all(`SELECT * FROM orchestration_events WHERE sequence < ?`, start),
  );
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const keep = new Set(earlier.match(uuidPattern) ?? []);
  const versions = all(
    `SELECT min(stream_version) AS lo, max(stream_version) AS hi FROM orchestration_events WHERE stream_id = ? AND sequence >= ?`,
    threadId,
    start,
  )[0]!;
  const span = (versions.hi as number) - (versions.lo as number) + 1;
  const templateTime = Date.parse(templateEvents[0]!.occurred_at);
  const spacingMs = 20_000;

  const templateRows = (table: string, where: string, ...params: string[]) => ({
    table,
    rows: all(`SELECT * FROM ${table} WHERE ${where}`, ...params),
  });
  const turnItems = templateRows("orchestration_v2_projection_turn_items", "run_id = ?", run2);
  const projections = [
    templateRows("orchestration_v2_projection_runs", "run_id = ?", run2),
    templateRows("orchestration_v2_projection_run_attempts", "run_id = ?", run2),
    templateRows("orchestration_v2_projection_nodes", "run_id = ?", run2),
    templateRows("orchestration_v2_projection_messages", "run_id = ?", run2),
    turnItems,
    templateRows("orchestration_v2_projection_checkpoints", "run_id = ?", run2),
    templateRows(
      "orchestration_v2_projection_provider_turns",
      "thread_id = ? AND ordinal = 2",
      threadId,
    ),
    {
      table: "orchestration_v2_turn_item_positions",
      rows: turnItems.rows.map((row) => ({
        thread_id: row.thread_id,
        turn_item_id: row.turn_item_id,
        ordinal: row.ordinal,
      })),
    },
  ];

  const mapOrdinal = (value: number, k: number) =>
    value === 2
      ? k
      : value >= 2_000_000 && value < 3_000_000
        ? value - 2_000_000 + k * 1_000_000
        : value;
  const ordinalColumns = new Set(["ordinal", "ordinal_within_scope", "app_run_ordinal"]);
  const rewrite = (text: string, k: number, shiftMs: number) =>
    text
      .replace(uuidPattern, (uuid) => {
        if (keep.has(uuid)) return uuid;
        const hex = NodeCrypto.createHash("sha1").update(`${uuid}:${k}`).digest("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      })
      .replace(
        /(ordinal|turn|name)(:|%3A|%253A|\/)([12])(?![0-9])/g,
        (match, kind, separator, n) =>
          kind === "ordinal" && n === "1" ? match : `${kind}${separator}${k - 2 + Number(n)}`,
      )
      .replace(
        /"(ordinal|ordinalWithinScope|appRunOrdinal|lastRunOrdinal)":(\d+)/g,
        (_match, key, n) => `"${key}":${mapOrdinal(Number(n), k)}`,
      )
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) =>
        new Date(Date.parse(iso) + shiftMs).toISOString(),
      )
      // Distinct text per turn, so rendering and highlighting caches see real variety.
      .replace(/Long chat turn 2(?![0-9])/g, `Long chat turn ${k}`)
      .replace(/All 42 tests pass/g, `All ${k} tests pass`)
      .replace(/request\.url\)/g, `request.url.slice(${k % 97}))`);
  const cloneRow = (row: Record<string, any>, k: number, shiftMs: number) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        typeof value === "string"
          ? rewrite(value, k, shiftMs)
          : ordinalColumns.has(column) && typeof value === "number"
            ? mapOrdinal(value, k)
            : value,
      ]),
    );
  const insert = (table: string, row: Record<string, any>) => {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...Object.values(row));
  };

  // Earlier turns move back in time so the whole chat ends at the template turn's time.
  const totalShift = -(LONG_TURNS - 2) * spacingMs;
  const shiftOf = (k: number) => totalShift + (k - 2) * spacingMs;
  db.exec("BEGIN");
  const retime = (table: string, key: string, where: string, ...params: string[]) => {
    for (const row of all(`SELECT * FROM ${table} WHERE ${where}`, ...params)) {
      const shifted = Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          typeof value === "string"
            ? value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) =>
                new Date(Date.parse(iso) + totalShift).toISOString(),
              )
            : value,
        ]),
      );
      const columns = Object.keys(shifted).filter((column) => column !== key);
      db.prepare(
        `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(",")} WHERE ${key} = ?`,
      ).run(...columns.map((column) => shifted[column]), row[key]);
    }
  };
  retime("orchestration_events", "sequence", "stream_id = ?", threadId);
  for (const [table, key] of [
    ["orchestration_v2_projection_runs", "run_id"],
    ["orchestration_v2_projection_run_attempts", "attempt_id"],
    ["orchestration_v2_projection_nodes", "node_id"],
    ["orchestration_v2_projection_messages", "message_id"],
    ["orchestration_v2_projection_turn_items", "turn_item_id"],
    ["orchestration_v2_projection_checkpoints", "checkpoint_id"],
    ["orchestration_v2_projection_checkpoint_scopes", "scope_id"],
    ["orchestration_v2_projection_provider_turns", "provider_turn_id"],
  ] as const) {
    retime(table, key, "thread_id = ?", threadId);
  }
  for (let k = 3; k <= LONG_TURNS; k++) {
    for (const event of templateEvents) {
      const { sequence: _sequence, ...row } = cloneRow(event, k, shiftOf(k));
      insert("orchestration_events", {
        ...row,
        stream_version: event.stream_version + (k - 2) * span,
      });
    }
    for (const { table, rows } of projections)
      for (const row of rows) insert(table, cloneRow(row, k, shiftOf(k)));
    if (k % 5000 === 0) {
      db.exec("COMMIT; BEGIN");
      log(`  ${k}/${LONG_TURNS} turns`);
    }
  }
  const lastTime = new Date(templateTime + shiftOf(LONG_TURNS) + 1000).toISOString();
  db.prepare(
    `UPDATE orchestration_v2_projection_provider_threads SET last_run_ordinal = ?, payload_json = json_set(payload_json, '$.lastRunOrdinal', ?) WHERE thread_id = ?`,
  ).run(LONG_TURNS, LONG_TURNS, threadId);
  db.prepare(
    `UPDATE orchestration_v2_projection_threads SET updated_at = ?, payload_json = json_set(payload_json, '$.updatedAt', ?, '$.lastVisitedAt', ?, '$.createdAt', ?) WHERE thread_id = ?`,
  ).run(
    lastTime,
    lastTime,
    lastTime,
    new Date(templateTime + totalShift - 60_000).toISOString(),
    threadId,
  );
  db.prepare(
    `UPDATE orchestration_v2_projection_metadata SET last_sequence = (SELECT max(sequence) FROM orchestration_events) WHERE projection_name = 'thread-projections'`,
  ).run();
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const messages = all(
    `SELECT count(*) AS n FROM orchestration_v2_projection_messages WHERE thread_id = ?`,
    threadId,
  )[0]!.n;
  log(`long chat has ${messages} messages`);
  db.close();
}

const TRACE_CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "v8",
].join(",");

interface TraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ph: string;
  readonly pid: number;
  readonly tid: number;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: any;
}

async function traced<T>(
  cdp: Cdp,
  body: () => Promise<T>,
): Promise<{ value: T; trace: TraceStats }> {
  const events: TraceEvent[] = [];
  const onData = (params: { value: TraceEvent[] }) => events.push(...params.value);
  const stop = cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { includedCategories: TRACE_CATEGORIES.split(",") },
  });
  const started = performance.now();
  const value = await body();
  const seconds = (performance.now() - started) / 1000;
  let done = () => {};
  const complete = new Promise<void>(
    (resolve) => (done = cdp.on("Tracing.tracingComplete", () => resolve())),
  );
  await cdp.send("Tracing.end");
  await complete;
  done();
  stop();
  return { value, trace: traceStats(events, seconds) };
}

interface TraceStats {
  readonly slowestFramesMs: number[];
  readonly slowestFrameMs: number;
  readonly slowestTask: string;
  readonly mainThreadBusyPct: number;
  readonly framesPerSec: number;
  readonly paintsPerSec: number;
  readonly timersPerSec: number;
  readonly droppedFrames: number;
}

function traceStats(events: TraceEvent[], seconds: number): TraceStats {
  const threadNames = new Map<string, string>();
  for (const event of events)
    if (event.ph === "M" && event.name === "thread_name")
      threadNames.set(`${event.pid}:${event.tid}`, event.args.name);
  const mainThreads = new Set(
    [...threadNames].filter(([, name]) => name === "CrRendererMain").map(([key]) => key),
  );
  const onMain = (event: TraceEvent) => mainThreads.has(`${event.pid}:${event.tid}`);
  // The page renderer is the one with the most main-thread work.
  // Newer Chromium names the scheduler task ThreadControllerImpl::RunTask.
  const isTask = (event: TraceEvent) =>
    event.ph === "X" &&
    (event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask");
  const busy = new Map<string, number>();
  for (const event of events)
    if (isTask(event) && onMain(event))
      busy.set(
        `${event.pid}:${event.tid}`,
        (busy.get(`${event.pid}:${event.tid}`) ?? 0) + (event.dur ?? 0),
      );
  const main = [...busy].sort((a, b) => b[1] - a[1])[0]?.[0];
  const pagePid = Number(main?.split(":")[0]);
  const taskEvents = events
    .filter((event) => isTask(event) && `${event.pid}:${event.tid}` === main)
    .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0));
  const tasks = taskEvents.map((event) => (event.dur ?? 0) / 1000);
  // What the longest task spent its time in, to say where a slow frame came from.
  const longest = taskEvents[0];
  const inside = new Map<string, number>();
  for (const event of events) {
    if (
      !longest ||
      event === longest ||
      event.ph !== "X" ||
      isTask(event) ||
      event.pid !== longest.pid ||
      event.tid !== longest.tid ||
      event.ts < longest.ts ||
      event.ts + (event.dur ?? 0) > longest.ts + (longest.dur ?? 0)
    )
      continue;
    const data = event.args?.data;
    const label =
      event.name === "FunctionCall"
        ? `${data?.functionName || "(anon)"} ${String(data?.url ?? "")
            .split("/")
            .pop()}:${data?.lineNumber}`
        : event.name;
    inside.set(label, (inside.get(label) ?? 0) + (event.dur ?? 0) / 1000);
  }
  const slowestTask = [...inside]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, ms]) => `${label}=${round(ms)}`)
    .join(" | ");
  const count = (name: string) =>
    events.filter((event) => event.name === name && event.pid === pagePid && event.ph !== "e")
      .length;
  const dropped = events.filter(
    (event) =>
      event.name === "PipelineReporter" &&
      event.ph === "b" &&
      event.pid === pagePid &&
      event.args?.frame_reporter?.state === "STATE_DROPPED",
  ).length;
  const slowestFramesMs = tasks.slice(0, 5).map((value) => round(value));
  return {
    slowestFramesMs,
    slowestFrameMs: slowestFramesMs[0] ?? 0,
    slowestTask,
    mainThreadBusyPct: round(
      (tasks.reduce((sum, value) => sum + value, 0) / (seconds * 1000)) * 100,
      2,
    ),
    framesPerSec: round(count("DrawFrame") / seconds, 2),
    paintsPerSec: round(count("Paint") / seconds, 2),
    timersPerSec: round(count("TimerFire") / seconds, 2),
    droppedFrames: dropped,
  };
}

// Event Timing: input-to-next-paint for every interaction slower than 16 ms.
const OBSERVE_INPUT = `(() => {
  window.__perfInput = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__perfInput.push({ name: entry.name, duration: entry.duration });
  }).observe({ type: "event", durationThreshold: 16 });
})()`;

// Opens the long chat with no client cache, as a new device, a browser or the
// mobile app does: the server builds the snapshot instead of resuming one.
async function measureFirstOpen(app: string, template: string, out: string, port: number) {
  const home = freshHome(template, NodePath.join(out, "home-first-open"));
  const support = NodePath.join(home, "Library/Application Support");
  for (const name of NodeFS.readdirSync(support))
    NodeFS.rmSync(NodePath.join(support, name, "IndexedDB"), { recursive: true, force: true });
  const session = await launch(app, home, port);
  try {
    await session.cdp.waitFor(
      `!!${COMPOSER} && document.querySelectorAll("[data-thread-item]").length >= 4`,
      60_000,
      10,
    );
    await sleep(3000);
    const { value: open, trace } = await traced(session.cdp, async () => {
      const opened = await openThread(session.cdp, LONG_TITLE);
      await sleep(1500);
      return opened;
    });
    return {
      openMs: round(open.openMs, 0),
      liveMs: round(open.liveMs, 0),
      ...trace,
      memoryMB: footprintByRole(session.child.pid!),
    };
  } finally {
    await quit(session);
  }
}

async function measureLaunch(app: string, template: string, out: string, port: number) {
  const home = freshHome(template, NodePath.join(out, "home-launch"));
  const session = await launch(app, home, port);
  const { value: usableAt, trace } = await traced(session.cdp, async () => {
    const at = await session.cdp.waitFor(
      `!!${COMPOSER} && document.querySelectorAll("[data-thread-item]").length >= 4`,
      60_000,
      10,
    );
    await sleep(1500);
    return at;
  });
  const result = {
    windowMs: round(session.pageAt - session.spawnedAt, 0),
    usableMs: round(usableAt - session.spawnedAt, 0),
    ...trace,
    memoryMB: footprintByRole(session.child.pid!),
  };
  await quit(session);
  return result;
}

async function measureSession(
  app: string,
  template: string,
  out: string,
  port: number,
  deep: boolean,
) {
  const home = freshHome(template, NodePath.join(out, "home-session"));
  const session = await launch(app, home, port);
  const scenes: Record<string, unknown> = {};
  try {
    await sessionScenes(session, out, deep, scenes);
    return scenes;
  } catch (error) {
    NodeFS.writeFileSync(
      NodePath.join(out, "results-partial.json"),
      `${JSON.stringify(scenes, null, 2)}\n`,
    );
    throw error;
  } finally {
    await quit(session);
  }
}

const ROWS = `document.querySelectorAll("[data-timeline-row-id]").length`;
const SETTLED = `(${ROWS} > 0 && !document.querySelector("[data-timeline-loading]"))`;
// The sync banner appears only after a 400 ms delay (STATUS_SHOW_DELAY_MS), so
// a chat counts as live once the banner has come and gone, or never shown by 450 ms.
const LIVE_AFTER_MS = `new Promise((resolve) => {
  const started = performance.now();
  let seen = false;
  const tick = () => {
    const banner = !!document.querySelector("[data-composer-sync-status]");
    seen ||= banner;
    if (seen && !banner) return resolve(performance.now() - started);
    if (!seen && performance.now() - started > 450) return resolve(0);
    if (performance.now() - started > 60000) return resolve(performance.now() - started);
    setTimeout(tick, 8);
  };
  tick();
})`;

// Clicks a chat in the sidebar. `openMs` is when its timeline has rendered
// (possibly from the client cache), `liveMs` when it has synced with the server.
async function openThread(cdp: Cdp, title: string) {
  const threadId = await cdp.eval<string>(
    `${threadRow(title)}.getAttribute("data-thread-item").split(":").pop()`,
  );
  const started = performance.now();
  await cdp.click(threadRow(title));
  const rendered = await cdp.waitFor(
    `location.hash.includes(${JSON.stringify(threadId)}) && ${SETTLED}`,
    60_000,
    4,
  );
  const openMs = rendered - started;
  return { openMs, liveMs: openMs + (await cdp.eval<number>(LIVE_AFTER_MS)) };
}

async function sessionScenes(
  session: RunningApp,
  out: string,
  deep: boolean,
  scenes: Record<string, unknown>,
) {
  const { cdp } = session;
  const pid = session.child.pid!;
  const cpuOver = async (body: () => Promise<void>) => {
    const before = processTree(pid);
    const started = performance.now();
    await body();
    return cpuByRole(before, processTree(pid), (performance.now() - started) / 1000);
  };
  await cdp.waitFor(
    `!!${COMPOSER} && document.querySelectorAll("[data-thread-item]").length >= 4`,
    60_000,
  );
  await sleep(5000);

  // Idle: one minute with nothing happening.
  {
    let trace: TraceStats | undefined;
    let wakeups: Record<string, number> = {};
    const started = performance.now();
    const cpu = await cpuOver(async () => {
      trace = (await traced(cdp, () => sleep(15_000))).trace;
      wakeups = wakeupsByRole(pid, 15);
      if (deep) captureIdleSamples(pid, out);
      await sleep(Math.max(0, 60_000 - (performance.now() - started)));
    });
    scenes.idle = {
      appCpuPct: cpu.total,
      cpuPct: cpu,
      wakeupsPerSec: wakeups,
      ...trace,
      memoryMB: footprintByRole(pid),
    };
  }

  // Open the long chat.
  {
    const { value: open, trace } = await traced(cdp, async () => {
      const opened = await openThread(cdp, LONG_TITLE);
      await sleep(1500);
      return opened;
    });
    scenes.openLongChat = {
      openMs: round(open.openMs, 0),
      liveMs: round(open.liveMs, 0),
      ...trace,
      memoryMB: footprintByRole(pid),
    };
  }

  // Scroll the long chat up through history like a fast trackpad fling, then back down.
  {
    // Wheel events must land on the scroll container; the first row may be off-screen.
    const point = await cdp.eval<{ x: number; y: number }>(`(() => {
      let scroller = document.querySelector("[data-timeline-row-id]");
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && getComputedStyle(scroller).overflowY !== "visible"))
        scroller = scroller.parentElement;
      const rect = scroller.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const oldestTurn = () =>
      cdp.eval<number>(
        `Math.min(...[...document.querySelectorAll("[data-timeline-row-id]")].map((row) => Number(row.innerText.match(/Long chat turn (\\d+)/)?.[1] ?? Infinity)))`,
      );
    let result: { trace: TraceStats; value: number } | undefined;
    const cpu = await cpuOver(async () => {
      result = await traced(cdp, async () => {
        let oldest = Infinity;
        for (let step = 0; step < 600; step++) {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            ...point,
            deltaX: 0,
            deltaY: step < 450 ? -120 : 120,
          });
          await sleep(16);
          if (step % 50 === 49 && step < 450) oldest = Math.min(oldest, await oldestTurn());
        }
        await sleep(500);
        return oldest;
      });
    });
    scenes.scrollLongChat = {
      oldestTurnReached: Number.isFinite(result!.value) ? result!.value : 0,
      cpuPct: cpu,
      ...result!.trace,
      memoryMB: footprintByRole(pid),
    };
  }

  // Three chats streaming at once, the last one in view.
  {
    for (const title of STREAM_TITLES) {
      await openThread(cdp, title);
      await sendPrompt(cdp, "stream 75");
      await sleep(500);
    }
    await sleep(3000);
    let trace: TraceStats | undefined;
    if (deep) recordXctrace(pid, out, "Time Profiler", ["renderer", "server"], "streaming");
    const cpu = await cpuOver(async () => {
      trace = (await traced(cdp, () => sleep(15_000))).trace;
    });
    scenes.streaming = {
      rendererCpuPct: cpu.renderer,
      cpuPct: cpu,
      ...trace,
      memoryMB: footprintByRole(pid),
    };
  }

  // The same streams in the background while an idle chat is in view.
  {
    await openThread(cdp, LONG_TITLE);
    await sleep(3000);
    let trace: TraceStats | undefined;
    if (deep) recordXctrace(pid, out, "Allocations", ["renderer"], "background-streaming");
    const cpu = await cpuOver(async () => {
      trace = (await traced(cdp, () => sleep(15_000))).trace;
    });
    scenes.backgroundStreaming = {
      rendererCpuPct: cpu.renderer,
      cpuPct: cpu,
      ...trace,
      memoryMB: footprintByRole(pid),
    };
  }
  // Let the streams finish before the interactive scenes.
  await cdp
    .waitFor(`!document.body.innerText.includes("Working")`, 90_000, 500)
    .catch(() => undefined);
  await sleep(2000);

  // Switching chats, pages and windows.
  {
    await cdp.eval(OBSERVE_INPUT);
    const { value, trace } = await traced(cdp, async () => {
      const switches: number[] = [];
      for (const title of [...STREAM_TITLES, LONG_TITLE, ...STREAM_TITLES, LONG_TITLE]) {
        switches.push((await openThread(cdp, title)).openMs);
        await sleep(300);
      }
      // Cmd+, is a native menu accelerator that CDP key events never reach; the sidebar button takes the same route.
      const settingsStarted = performance.now();
      await cdp.click(sidebarButton("Settings"));
      const settingsMs =
        (await cdp.waitFor(
          `location.hash.includes("/settings") && !!${sidebarButton("Back")}`,
          10_000,
          4,
        )) - settingsStarted;
      await sleep(500);
      await cdp.click(sidebarButton("Back"));
      await cdp.waitFor(`!location.hash.includes("/settings") && ${SETTLED}`, 10_000, 4);
      await sleep(500);
      const paletteStarted = performance.now();
      await cdp.key("k", { meta: true });
      const paletteMs =
        (await cdp.waitFor(`!!document.querySelector("[role=dialog]")`, 10_000, 4)) -
        paletteStarted;
      await sleep(300);
      await cdp.key("Escape", { code: "Escape", keyCode: 27 });
      await sleep(300);
      switches.sort((a, b) => a - b);
      return {
        switchMs: round(switches[Math.floor(switches.length / 2)]!, 0),
        slowestSwitchMs: round(switches.at(-1)!, 0),
        settingsMs: round(settingsMs, 0),
        paletteMs: round(paletteMs, 0),
      };
    });
    // Window: minimise and restore through the main process, outside the trace:
    // tasks that run while minimised are not frames anyone sees.
    const [mainTarget] = (await fetch(`http://127.0.0.1:${session.port + 1000}/json/list`).then(
      (response) => response.json(),
    )) as Array<{ webSocketDebuggerUrl: string }>;
    const main = await Cdp.connect(mainTarget!.webSocketDebuggerUrl);
    const windowCall = async (expression: string) =>
      (
        await main.send("Runtime.evaluate", {
          expression: `require("electron").BrowserWindow.getAllWindows().map((window) => ${expression})`,
          includeCommandLineAPI: true,
          returnByValue: true,
        })
      ).result.value as unknown[];
    await windowCall("window.minimize()");
    while (!(await windowCall("window.isMinimized()")).includes(true)) await sleep(16);
    await sleep(1000);
    const restoreStarted = performance.now();
    await windowCall("window.restore()");
    while ((await windowCall("window.isMinimized()")).includes(true)) await sleep(4);
    // The page stays "visible" while minimised, so wait for its next painted frame instead.
    await cdp.eval(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const restoreMs = performance.now() - restoreStarted;
    main.close();
    await sleep(800);
    const slowInputs = await cdp.eval<Array<{ duration: number }>>(`window.__perfInput`);
    scenes.switching = {
      ...value,
      windowRestoreMs: round(restoreMs, 0),
      inputToPaintMs: Math.max(0, ...slowInputs.map((entry) => entry.duration)),
      ...trace,
      memoryMB: footprintByRole(pid),
    };
  }

  // Operating the app: typing, the sidebar, the command palette search.
  {
    await openThread(cdp, STREAM_TITLES[0]!);
    await sleep(800);
    await cdp.eval(OBSERVE_INPUT);
    const { trace } = await traced(cdp, async () => {
      await cdp.eval(`${COMPOSER}.focus()`);
      for (const character of "Refactor the request router and add tests for edge cases") {
        await cdp.key(character, character === " " ? { code: "Space", keyCode: 32 } : {});
        await sleep(35);
      }
      for (let toggle = 0; toggle < 4; toggle++) {
        await cdp.key("b", { meta: true });
        await sleep(400);
      }
      await cdp.key("k", { meta: true });
      await sleep(300);
      for (const character of "stream") {
        await cdp.key(character);
        await sleep(60);
      }
      await sleep(300);
      await cdp.key("Escape", { code: "Escape", keyCode: 27 });
      await sleep(500);
    });
    const slowInputs = await cdp.eval<Array<{ duration: number }>>(`window.__perfInput`);
    const durations = slowInputs.map((entry) => entry.duration).sort((a, b) => b - a);
    scenes.operating = {
      inputToPaintMs: durations[0] ?? 0,
      slowInputs: durations.length,
      ...trace,
      memoryMB: footprintByRole(pid),
    };
  }

  if (deep) captureMemoryMaps(pid, out);
}

// Deep captures: xctrace, sample and vmmap. Each writes raw output under out/.

function rolePid(rootPid: number, role: string) {
  return processTree(rootPid).find((row) => row.role === role)?.pid;
}

function captureIdleSamples(rootPid: number, out: string) {
  for (const role of ["main", "renderer", "gpu", "server"]) {
    const pid = rolePid(rootPid, role);
    if (pid)
      run("sample", [String(pid), "3", "-file", NodePath.join(out, `idle-sample-${role}.txt`)], {
        stdio: "ignore",
      });
  }
}

function recordXctrace(
  rootPid: number,
  out: string,
  template: string,
  roles: string[],
  name: string,
) {
  for (const role of roles) {
    const pid = rolePid(rootPid, role);
    if (!pid) continue;
    const trace = NodePath.join(out, `${name}-${role}.trace`);
    NodeFS.rmSync(trace, { recursive: true, force: true });
    const recorder = NodeChildProcess.spawn(
      "xcrun",
      [
        "xctrace",
        "record",
        "--template",
        template,
        "--attach",
        String(pid),
        "--time-limit",
        "10s",
        "--output",
        trace,
      ],
      {
        stdio: "ignore",
      },
    );
    // Attaching Allocations can hang on some Xcode versions; never let it outlive the run.
    const deadline = setTimeout(() => recorder.kill("SIGKILL"), 40_000);
    recorder.once("exit", () => clearTimeout(deadline));
  }
}

function captureMemoryMaps(rootPid: number, out: string) {
  for (const role of ["renderer", "server", "main"]) {
    const pid = rolePid(rootPid, role);
    if (pid)
      NodeFS.writeFileSync(
        NodePath.join(out, `vmmap-${role}.txt`),
        run("vmmap", ["-summary", String(pid)]),
      );
  }
}

// Bundle size: what makes the app big. Reads app.asar's own header, so it
// measures the packaged app rather than whatever is in the working tree.
function measureBundle(app: string) {
  const sizeMB = (path: string) => round(Number(run("du", ["-sk", path]).split("\t")[0]) / 1024);
  const asarPath = NodePath.join(app, "Contents/Resources/app.asar");
  const archive = NodeFS.readFileSync(asarPath);
  const headerSize = archive.readUInt32LE(4);
  const header = JSON.parse(
    archive.subarray(16, 16 + archive.readUInt32LE(12)).toString(),
  ) as AsarNode;
  const entry = (path: string) =>
    path.split("/").reduce<AsarNode | undefined>((node, name) => node?.files?.[name], header);
  const read = (path: string) => {
    const file = entry(path)!;
    const offset = 8 + headerSize + Number(file.offset);
    return archive.subarray(offset, offset + file.size!).toString();
  };
  const client = "apps/server/dist/client";
  const initialScripts = [
    ...read(`${client}/index.html`).matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g),
  ].map((match) => match[1]!);
  // Largest packages and files, for spotting what grew.
  const packages = new Map<string, number>();
  const walk = (node: AsarNode, path: string[]) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const childPath = [...path, name];
      if (child.files) walk(child, childPath);
      else if (!child.unpacked) {
        const modules = childPath.lastIndexOf("node_modules");
        const key =
          modules >= 0
            ? childPath.slice(0, modules + (childPath[modules + 1]?.startsWith("@") ? 3 : 2))
            : childPath.slice(0, 4);
        packages.set(key.join("/"), (packages.get(key.join("/")) ?? 0) + child.size!);
      }
    }
  };
  walk(header, []);
  return {
    appMB: sizeMB(app),
    electronFrameworkMB: sizeMB(
      NodePath.join(app, "Contents/Frameworks/Electron Framework.framework"),
    ),
    appAsarMB: round(archive.length / 1e6),
    initialScriptKB: round(
      initialScripts.reduce((total, path) => total + entry(`${client}/${path}`)!.size!, 0) / 1024,
      0,
    ),
    largestMB: Object.fromEntries(
      [...packages]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([path, size]) => [path, round(size / 1e6)]),
    ),
  };
}

interface AsarNode {
  readonly files?: Record<string, AsarNode>;
  readonly size?: number;
  readonly offset?: string;
  readonly unpacked?: boolean;
}

const flatten = (scenes: Record<string, any>) => {
  const rows: Array<[string, string, number]> = [];
  for (const [scene, metrics] of Object.entries(scenes)) {
    for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof value === "number") rows.push([scene, metric, value]);
      else if (metric === "memoryMB" || metric === "cpuPct")
        rows.push([scene, `${metric}.total`, (value as Record<string, number>).total ?? 0]);
    }
  }
  return rows;
};

function table(after: Record<string, any>, before?: Record<string, any>) {
  const previous = new Map(
    before ? flatten(before).map(([scene, metric, value]) => [`${scene}.${metric}`, value]) : [],
  );
  const lines = [
    "| scene | metric | budget | " + (before ? "before | after |" : "value |"),
    before ? "|---|---|---|---|---|" : "|---|---|---|---|",
  ];
  for (const [scene, metric, value] of flatten(after)) {
    const budget = BUDGETS[scene]?.[metric];
    const was = previous.get(`${scene}.${metric}`);
    const flag = budget !== undefined && value > budget ? " ✗" : "";
    lines.push(
      `| ${scene} | ${metric} | ${budget ?? ""} | ${before ? `${was ?? ""} | ` : ""}${value}${flag} |`,
    );
  }
  return lines.join("\n");
}

function buildApp(out: string) {
  log("building release app (scripts/build-desktop-artifact.ts --target dir)");
  const output = run(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/build-desktop-artifact.ts"),
      "--platform",
      "mac",
      "--target",
      "dir",
      "--output-dir",
      NodePath.join(out, "build"),
      "--keep-stage",
    ],
    {
      cwd: repoRoot,
      // The build shells out to `vp`, which lives in the workspace bin.
      env: {
        ...process.env,
        PATH: `${NodePath.join(repoRoot, "node_modules/.bin")}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stage = run("find", [
    NodeOS.tmpdir(),
    "-maxdepth",
    "1",
    "-name",
    "t3code-desktop-mac-stage-*",
    "-newer",
    NodePath.join(repoRoot, "package.json"),
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
  const dist =
    stage &&
    run("find", [NodePath.join(stage, "app/dist"), "-maxdepth", "2", "-name", "*.app"])
      .trim()
      .split("\n")[0];
  if (!dist) throw new Error(`build produced no .app:\n${output}`);
  const app = NodePath.join(out, NodePath.basename(dist));
  NodeFS.rmSync(app, { recursive: true, force: true });
  run("ditto", [dist, app]);
  NodeFS.rmSync(stage!, { recursive: true, force: true });
  return app;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "fake-agent") return fakeAgent();
  const flag = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  if (args.includes("--help")) {
    process.stdout.write(
      `${NodeFS.readFileSync(import.meta.filename, "utf8").split("\nimport")[0]}\n`,
    );
    return;
  }
  const out = NodePath.resolve(
    flag("out") ?? NodePath.join(NodeOS.tmpdir(), "t3code-desktop-perf"),
  );
  NodeFS.mkdirSync(out, { recursive: true });
  const app = NodePath.resolve(flag("app") ?? buildApp(out));
  const template = NodePath.resolve(flag("home") ?? NodePath.join(out, "home-template"));
  if (!NodeFS.existsSync(NodePath.join(template, ".t3/userdata/statev2.sqlite"))) {
    log(`seeding ${template}`);
    await seed(app, template);
  }
  if (args.includes("--seed-only")) return;
  const home = await warmedHome(app, template, out);
  const deep = args.includes("--deep");
  const bundle = measureBundle(app);
  const started = performance.now();
  const launches = [];
  for (let attempt = 0; attempt < 3; attempt++)
    launches.push(await measureLaunch(app, home, out, 9351));
  launches.sort((a, b) => a.usableMs - b.usableMs);
  log(`launch done in ${round((performance.now() - started) / 1000, 0)}s`);
  const firstOpenLongChat = await measureFirstOpen(app, home, out, 9353);
  const session = await measureSession(app, home, out, 9352, deep);
  const results = {
    app,
    date: new Date().toISOString(),
    bundle,
    launch: launches[1]!,
    firstOpenLongChat,
    ...session,
  };
  const resultsPath = NodePath.join(out, "results.json");
  NodeFS.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  log(`measured in ${round((performance.now() - started) / 1000, 0)}s, wrote ${resultsPath}`);
  const baseline = flag("baseline");
  const { app: _app, date: _date, ...scenes } = results;
  const before = baseline
    ? (({ app: _a, date: _d, ...rest }) => rest)(JSON.parse(NodeFS.readFileSync(baseline, "utf8")))
    : undefined;
  process.stdout.write(`${table(scenes, before)}\n`);
}

await main();
