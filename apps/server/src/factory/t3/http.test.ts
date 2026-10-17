// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files and read the pause file back.
// @effect-diagnostics globalDate:off - the pause time is the handler's wall clock, which the test brackets.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { Attention, type AttentionItem } from "../attention.ts";
import { FactoryLoop, hostName, type RepoConfigReading } from "../index.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { runIdToString, runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import { formatTs, parseTs } from "../ledger/time.ts";
import { stopRequestPath } from "../runner/stop.ts";
import type { FactoryStatus } from "../status.ts";
import { route } from "./auth.ts";
import { CONFIG_PATH, FactoryRoutes, STATUS_PATH } from "./http.ts";
import { FactoryPaths } from "./paths.ts";

const TEST_ROUTE_PATH = "/api/factory/test/settings";

/** A route that needs a scope a standard client lacks, to prove the scope check. */
const testOnlyRoute = route(
  "GET",
  TEST_ROUTE_PATH,
  AuthSettingsWriteScope,
  Effect.succeed(HttpServerResponse.empty({ status: 204 })),
);

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-http-test-" })),
  Layer.provide(NodeServices.layer),
);

const layerRoutes = Layer.mergeAll(FactoryRoutes, testOnlyRoute).pipe(
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
);

const tempDir = useTempDirs();

const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };
const ID = runIdToString(run10);
const run11: RunId = { repo: "rawphp/softfac", issue: "11", attempt: 1 };
const run12: RunId = { repo: "rawphp/softfac", issue: "12", attempt: 2 };

const CLAIMED: RunEvent = {
  event: "claimed",
  data: { machine: "mac-mini", github_user: "rawphp" },
};
const moved = (from: string, to: string): RunEvent =>
  ({ event: "state_changed", data: { from, to } }) as RunEvent;
const FINISHED: RunEvent = {
  event: "finished",
  data: {
    outcome: "pr-open",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};
const BUILDING: ReadonlyArray<RunEvent> = [
  CLAIMED,
  moved("ready", "triage"),
  moved("triage", "building"),
];

/** Writes a run's ledger, one second apart from `startMs`. */
const seed = (dir: string, id: RunId, events: ReadonlyArray<RunEvent>, startMs = T0) => {
  let now = startMs;
  const ledger = Ledger.create(dir, id, { clock: () => (now += 1000) });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const ledgerBytes = (dir: string, id: RunId = run10) =>
  NodeFS.readFileSync(runPath(dir, id), "utf8");

const attentionItem = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "stuck:a/b#1",
  kind: "stuck",
  repo: "a/b",
  issue: 1,
  run: "a__b__1__1",
  message: "run went stuck",
  firstSeenMs: T0,
  ...over,
});

/** A string body is sent as it is, so a test can send what is not JSON; anything else as JSON. */
type Call = (
  method: "GET" | "POST" | "PUT",
  path: string,
  token?: string,
  body?: unknown,
) => Promise<Response>;

interface Tokens {
  readonly read: string;
  readonly operate: string;
  readonly settingsWrite: string;
}

interface World {
  readonly status?: FactoryStatus;
  readonly passRunning?: boolean;
  readonly attention?: ReadonlyArray<AttentionItem>;
  /** The factory dir; the machine config is `<dir>/config.yml`. */
  readonly dir?: string;
  /** What the loop last read of each repo's project config. */
  readonly readings?: ReadonlyMap<string, RepoConfigReading>;
}

/** What the loop was asked to do: `count` wakes, `reloads` config reloads. */
interface Calls {
  count: number;
  reloads: number;
}

const attentionWith = (items: ReadonlyArray<AttentionItem>) =>
  Attention.of({
    list: () => Effect.succeed(items),
    raise: () => Effect.void,
    clear: () => Effect.void,
    passEnded: () => Effect.void,
    setNotify: () => Effect.void,
  });

const worldContext = (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  world: World,
  dir: string,
  wakes: Calls,
) =>
  Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
    Context.add(
      FactoryLoop,
      FactoryLoop.of({
        wake: Effect.sync(() => {
          wakes.count += 1;
        }),
        awaitPass: Effect.never,
        passRunning: Effect.succeed(world.passRunning ?? false),
        status: world.status ?? idle,
        reload: Effect.sync(() => {
          wakes.reloads += 1;
        }),
        repoConfigs: Effect.succeed(world.readings ?? new Map()),
      }),
    ),
    Context.add(Attention, attentionWith(world.attention ?? [])),
    Context.add(FactoryPaths, {
      baseDir: dir,
      worktreesDir: NodePath.join(dir, "worktrees"),
      factoryDir: dir,
      machineConfigPath: NodePath.join(dir, "config.yml"),
    }),
  );

/**
 * Runs `use` against the factory's routes behind T3's auth, with a loop reporting the world's
 * status and a factory dir in a temp directory. `wakes` counts the loop's wakes.
 */
const serving = <A>(
  world: World,
  use: (
    call: Call,
    context: { readonly tokens: Tokens; readonly dir: string; readonly wakes: Calls },
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const dir = world.dir ?? tempDir("factory");
    const wakes = { count: 0, reloads: 0 };
    const context = worldContext(auth, world, dir, wakes);
    // Issued on the live clock: the handler checks expiry on it, not on the test clock.
    const issue = (scope: AuthEnvironmentScope) =>
      auth.issueSession({ scopes: [scope] }).pipe(
        TestClock.withLive,
        Effect.map((session) => session.token),
      );
    const tokens: Tokens = {
      read: yield* issue(AuthOrchestrationReadScope),
      operate: yield* issue(AuthOrchestrationOperateScope),
      settingsWrite: yield* issue(AuthSettingsWriteScope),
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      ({ handler }) =>
        Effect.tryPromise(() =>
          use(
            (method, path, token, body) =>
              handler(
                new Request(`http://127.0.0.1${path}`, {
                  method,
                  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
                  ...(body === undefined
                    ? {}
                    : { body: typeof body === "string" ? body : JSON.stringify(body) }),
                }),
                context,
              ),
            { tokens, dir, wakes },
          ),
        ),
      ({ dispose }) => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(layerEnvironmentAuth));

const idle: FactoryStatus = { state: "idle", reason: "no factory config" };
const running: FactoryStatus = {
  state: "running",
  settings: { pollSeconds: 45, maxConcurrentRuns: 2, repos: ["rawphp/softfac"] },
};

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const FACTORY_ROUTES = [
  ["GET", "/api/factory/status"],
  ["GET", "/api/factory/runs"],
  ["GET", `/api/factory/runs/${ID}`],
  ["POST", `/api/factory/runs/${ID}/stop`],
  ["POST", "/api/factory/claims/pause"],
  ["POST", "/api/factory/claims/resume"],
  ["GET", "/api/factory/config"],
  ["PUT", "/api/factory/config"],
] as const;

describe("every factory route", () => {
  it("is served at the path the Factory page calls", () => {
    assert.strictEqual(STATUS_PATH, "/api/factory/status");
    assert.strictEqual(CONFIG_PATH, "/api/factory/config");
  });

  it.effect.each(FACTORY_ROUTES)("%s %s answers 401 without credentials", ([method, path]) =>
    serving({}, async (call) => {
      const response = await call(method, path);
      assert.strictEqual(response.status, 401);
      assert.strictEqual((await json(response)).code, "auth_invalid");
    }),
  );

  it.effect.each(FACTORY_ROUTES)(
    "%s %s answers 401 for a token that is not a session",
    ([method, path]) =>
      serving({}, async (call) => {
        const response = await call(method, path, "not-a-session-token");
        assert.strictEqual(response.status, 401);
      }),
  );

  it.effect("a GET needs orchestration:read, and a session with only operate is refused", () =>
    serving({}, async (call, { tokens }) => {
      for (const path of [
        "/api/factory/status",
        "/api/factory/runs",
        `/api/factory/runs/${ID}`,
        CONFIG_PATH,
      ]) {
        for (const token of [tokens.operate, tokens.settingsWrite]) {
          const response = await call("GET", path, token);
          assert.strictEqual(response.status, 403, path);
          assert.strictEqual((await json(response)).code, "insufficient_scope");
        }
      }
    }),
  );

  it.effect("a POST needs orchestration:operate, and a session with only read is refused", () =>
    serving({}, async (call, { tokens, wakes, dir }) => {
      seed(dir, run10, BUILDING);
      const bytes = ledgerBytes(dir);
      for (const path of [
        `/api/factory/runs/${ID}/stop`,
        "/api/factory/claims/pause",
        "/api/factory/claims/resume",
      ]) {
        const response = await call("POST", path, tokens.read);
        assert.strictEqual(response.status, 403, path);
        assert.strictEqual((await json(response)).code, "insufficient_scope");
      }
      assert.strictEqual(ledgerBytes(dir), bytes);
      assert.strictEqual(wakes.count, 0);
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "claims-paused")));
    }),
  );
});

describe("GET /api/factory/status", () => {
  it.effect("reports an idle factory and why, with the report's keys", () =>
    serving({ status: idle }, async (call, { tokens, dir }) => {
      const response = await call("GET", STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.strictEqual(body.state, "idle");
      assert.strictEqual(body.reason, "no factory config");
      assert.strictEqual(body.version, packageJson.version);
      assert.strictEqual(body.machine, hostName());
      assert.strictEqual(body.machine_config, NodePath.join(dir, "config.yml"));
      assert.strictEqual(body.data_dir, dir);
      assert.deepStrictEqual(Object.keys(body), [
        "state",
        "reason",
        "version",
        "machine_config",
        "machine",
        "data_dir",
        "passes",
        "slots",
        "paused_by_hand",
        "runs",
        "left_out",
        "problems",
        "attention",
      ]);
      assert.strictEqual((body.passes as { poll_seconds: unknown }).poll_seconds, null);
      assert.deepStrictEqual(body.slots, { used: 0, max: null });
    }),
  );

  it.effect("reports a running factory with its settings, whether a pass runs, and its runs", () =>
    serving({ status: running, passRunning: true }, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      const response = await call("GET", STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.strictEqual(body.state, "running");
      assert.strictEqual(body.reason, null);
      const passes = body.passes as { poll_seconds: number; running: boolean };
      assert.strictEqual(passes.poll_seconds, 45);
      assert.isTrue(passes.running);
      assert.strictEqual((body.slots as { max: number }).max, 2);
      assert.deepStrictEqual(
        (body.runs as Array<{ id: string; state: string }>).map((run) => [run.id, run.state]),
        [[ID, "building"]],
      );
    }),
  );

  it.effect("carries the open attention items", () =>
    serving({ status: running, attention: [attentionItem()] }, async (call, { tokens }) => {
      const body = await json(await call("GET", STATUS_PATH, tokens.read));
      assert.deepStrictEqual(body.attention, [
        {
          id: "stuck:a/b#1",
          kind: "stuck",
          repo: "a/b",
          issue: 1,
          run: "a__b__1__1",
          message: "run went stuck",
          first_seen: formatTs(T0),
        },
      ]);
    }),
  );

  it.effect("answers 500 factory_error when the machine log cannot be read", () =>
    serving({ status: running }, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(NodePath.join(dir, "real"), "");
      NodeFS.symlinkSync(NodePath.join(dir, "real"), NodePath.join(dir, "events.jsonl"));
      const response = await call("GET", STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 500);
      assert.strictEqual((await json(response)).code, "factory_error");
    }),
  );
});

describe("the scope a route requires", () => {
  it.effect("answers 403 to a session without it", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", TEST_ROUTE_PATH, tokens.read);
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await json(response)).code, "insufficient_scope");
    }),
  );

  it.effect("lets a session with it through", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", TEST_ROUTE_PATH, tokens.settingsWrite);
      assert.strictEqual(response.status, 204);
    }),
  );
});

describe("GET /api/factory/runs", () => {
  it.effect("is an empty list for an empty ledger", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", "/api/factory/runs", tokens.read);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { runs: [] });
    }),
  );

  it.effect("lists every run oldest first with the word runs list gives its status", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run12, [...BUILDING, FINISHED], T0 + 20_000);
      seed(dir, run10, BUILDING, T0);
      seed(
        dir,
        run11,
        [
          CLAIMED,
          moved("ready", "triage"),
          moved("triage", "building"),
          moved("building", "pr-open"),
        ],
        T0 + 10_000,
      );
      const body = (await json(await call("GET", "/api/factory/runs", tokens.read))) as {
        runs: Array<Record<string, unknown>>;
      };
      assert.deepStrictEqual(
        body.runs.map((run) => [run.id, run.state, run.status, run.finished, run.last_event]),
        [
          [ID, "building", "running", false, "state_changed"],
          [runIdToString(run11), "pr-open", "watching", false, "state_changed"],
          [runIdToString(run12), "building", "finished", true, "finished"],
        ],
      );
      assert.deepStrictEqual(Object.keys(body.runs[0]!), [
        "id",
        "started_ts",
        "state",
        "last_event",
        "status",
        "pr_url",
        "finished",
        "total_ms",
        "unreadable",
      ]);
      assert.strictEqual(body.runs[0]!.started_ts, formatTs(T0 + 1000));
      assert.strictEqual(body.runs[0]!.unreadable, false);
    }),
  );

  it.effect("lists a run file that cannot be read as unreadable", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      // A regular file over the 2 GiB a Node read allows: it fails at once, whoever runs the test.
      const broken = NodePath.join(dir, "runs", "rawphp__broken__2__1.jsonl");
      NodeFS.writeFileSync(broken, "");
      NodeFS.truncateSync(broken, 3 * 2 ** 30);
      const body = (await json(await call("GET", "/api/factory/runs", tokens.read))) as {
        runs: Array<Record<string, unknown>>;
      };
      assert.deepStrictEqual(
        body.runs.map((run) => [run.id, run.status, run.unreadable]),
        [
          [ID, "running", false],
          ["rawphp__broken__2__1", "unreadable", true],
        ],
      );
    }),
  );
});

describe("GET /api/factory/runs/:id", () => {
  it.effect("shows each entry with its time, event, data and cause", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      const response = await call("GET", `/api/factory/runs/${ID}`, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = (await json(response)) as {
        id: string;
        entries: Array<Record<string, unknown>>;
        truncated: boolean;
        skipped: number;
      };
      assert.strictEqual(body.id, ID);
      assert.deepStrictEqual(
        body.entries.map((entry) => entry.event),
        ["claimed", "state_changed", "state_changed"],
      );
      assert.deepStrictEqual(body.entries[0], {
        ts: formatTs(T0 + 1000),
        ms: T0 + 1000,
        event: "claimed",
        data: { machine: "mac-mini", github_user: "rawphp" },
        cause: { step: "start", reason: "seed" },
      });
      assert.strictEqual(body.truncated, false);
      assert.strictEqual(body.skipped, 0);
    }),
  );

  it.effect("counts the damaged lines it skips", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      const path = runPath(dir, run10);
      const lines = NodeFS.readFileSync(path, "utf8").split("\n");
      // One damaged line in the middle, and a last line cut off.
      NodeFS.writeFileSync(
        path,
        [lines[0], "not json", lines[1], lines[2], '{"ts":"2026-10-0'].join("\n"),
      );
      const body = (await json(await call("GET", `/api/factory/runs/${ID}`, tokens.read))) as {
        entries: Array<unknown>;
        truncated: boolean;
        skipped: number;
      };
      assert.strictEqual(body.entries.length, 3);
      assert.strictEqual(body.skipped, 1);
      assert.isTrue(body.truncated);
    }),
  );

  it.effect("answers 404 run_not_found for a run with no ledger", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", `/api/factory/runs/${ID}`, tokens.read);
      assert.strictEqual(response.status, 404);
      assert.deepStrictEqual(await response.json(), {
        code: "run_not_found",
        id: ID,
        message: `no run ${ID}`,
      });
    }),
  );

  it.effect("answers 400 invalid_run_id for an id that could reach another file", () =>
    serving({}, async (call, { tokens, dir }) => {
      for (const id of ["..%2F..%2Fetc%2Fpasswd", "a%2Fb", "not-a-run", "x__y__1__01"]) {
        const response = await call("GET", `/api/factory/runs/${id}`, tokens.read);
        assert.strictEqual(response.status, 400, id);
        const body = await json(response);
        assert.strictEqual(body.code, "invalid_run_id");
        assert.isString(body.message);
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "runs")));
    }),
  );

  it.effect("answers 404 for a symlink named like a run and shows nothing from its target", () =>
    serving({}, async (call, { tokens, dir }) => {
      const target = NodePath.join(dir, "secret.txt");
      NodeFS.writeFileSync(target, '{"ts":"x","ms":1,"event":"leaked","data":null}\n');
      NodeFS.mkdirSync(NodePath.join(dir, "runs"));
      NodeFS.symlinkSync(target, runPath(dir, run10));
      const response = await call("GET", `/api/factory/runs/${ID}`, tokens.read);
      assert.strictEqual(response.status, 404);
      assert.notInclude(await response.text(), "leaked");
    }),
  );
});

describe("POST /api/factory/runs/:id/stop", () => {
  const stop = (call: Call, token: string, id = ID) =>
    call("POST", `/api/factory/runs/${id}/stop`, token);

  it.effect("leaves a stop request for a building run once, and wakes the loop", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, BUILDING);
      const bytes = ledgerBytes(dir);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        stopped: ID,
        already: false,
        message: `stop requested: ${ID}; the issue goes to factory:stuck on the next pass`,
      });
      const request = stopRequestPath(dir, run10);
      assert.strictEqual(NodeFS.readFileSync(request, "utf8"), "operator\n");
      assert.strictEqual(ledgerBytes(dir), bytes, "the route writes no ledger line");
      assert.strictEqual(wakes.count, 1);

      const again = await stop(call, tokens.operate);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual(await again.json(), {
        stopped: ID,
        already: true,
        message: `stop already requested: ${ID}; the issue goes to factory:stuck on the next pass`,
      });
      assert.strictEqual(NodeFS.readFileSync(request, "utf8"), "operator\n");
      assert.strictEqual(ledgerBytes(dir), bytes, "still no ledger line");
      assert.strictEqual(wakes.count, 1, "no second wake");
    }),
  );

  it.effect("refuses a run that left building with a stale stop line, and wakes nothing", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, [
        ...BUILDING,
        { event: "stop_requested", data: { by: "operator" } },
        moved("building", "pr-open"),
      ]);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.strictEqual((await json(response)).code, "not_building");
      assert.isFalse(NodeFS.existsSync(stopRequestPath(dir, run10)));
      assert.strictEqual(wakes.count, 0);
    }),
  );

  it.effect("refuses a run waiting on its pull request, and says how it ends", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, [...BUILDING, moved("building", "pr-open")]);
      const bytes = ledgerBytes(dir);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(await response.json(), {
        code: "not_building",
        message: `run ${ID} is not building: its state is pr-open. Only a building run is stopped this way. It ends when its pull request is merged or closed.`,
      });
      assert.strictEqual(ledgerBytes(dir), bytes);
      assert.strictEqual(wakes.count, 0);
    }),
  );

  it.effect("refuses a finished run", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, [...BUILDING, FINISHED]);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(await response.json(), {
        code: "not_building",
        message: `run ${ID} is not building: it is finished. Only a building run is stopped this way.`,
      });
    }),
  );

  it.effect("refuses a run in triage, and says to close its issue", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, [CLAIMED, moved("ready", "triage")]);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.include(
        ((await json(response)).message as string) ?? "",
        "To end it, close its issue.",
      );
    }),
  );

  it.effect("answers 500 factory_error and wakes nothing when the request cannot be written", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, BUILDING);
      NodeFS.writeFileSync(NodePath.join(dir, "stop-requests"), "");
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 500);
      assert.strictEqual((await json(response)).code, "factory_error");
      assert.strictEqual(wakes.count, 0);
    }),
  );

  // Root writes into a read-only directory, so the failure cannot be set up that way as root.
  it.effect.skipIf(process.getuid?.() === 0)(
    "answers 500 factory_error, wakes nothing and leaves no request when the write is refused",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        seed(dir, run10, BUILDING);
        const requests = NodePath.join(dir, "stop-requests");
        NodeFS.mkdirSync(requests);
        NodeFS.chmodSync(requests, 0o500);
        try {
          const response = await stop(call, tokens.operate);
          assert.strictEqual(response.status, 500);
          assert.strictEqual((await json(response)).code, "factory_error");
          assert.strictEqual(wakes.count, 0);
          assert.isFalse(NodeFS.existsSync(stopRequestPath(dir, run10)));
        } finally {
          NodeFS.chmodSync(requests, 0o700);
        }
      }),
  );

  it.effect("answers 404 for an unknown run and 400 for a bad id", () =>
    serving({}, async (call, { tokens, wakes }) => {
      const unknown = await stop(call, tokens.operate);
      assert.strictEqual(unknown.status, 404);
      assert.deepStrictEqual(await unknown.json(), {
        code: "run_not_found",
        id: ID,
        message: `no run ${ID}`,
      });
      const bad = await stop(call, tokens.operate, "..%2F..%2Fetc%2Fpasswd");
      assert.strictEqual(bad.status, 400);
      assert.strictEqual((await json(bad)).code, "invalid_run_id");
      assert.strictEqual(wakes.count, 0);
    }),
  );
});

describe("claims pause and resume", () => {
  const pauseFile = (dir: string) => NodePath.join(dir, "claims-paused");

  it.effect("pause writes the time privately, and again keeps the first", () =>
    serving({}, async (call, { tokens, dir }) => {
      const before = Date.now();
      const response = await call("POST", "/api/factory/claims/pause", tokens.operate);
      const after = Date.now();
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.deepStrictEqual(body, {
        paused: true,
        already: false,
        since: body.since,
        message: "claims paused",
      });
      const since = parseTs(body.since as string)!;
      assert.isTrue(since >= before && since <= after, "stamped with the handler's clock");
      assert.strictEqual(NodeFS.readFileSync(pauseFile(dir), "utf8"), `${body.since}\n`);
      assert.strictEqual(NodeFS.statSync(pauseFile(dir)).mode & 0o777, 0o600);

      const again = await json(await call("POST", "/api/factory/claims/pause", tokens.operate));
      assert.deepStrictEqual(again, {
        paused: true,
        already: true,
        since: body.since,
        message: `claims already paused since ${String(body.since)}`,
      });
      assert.strictEqual(NodeFS.readFileSync(pauseFile(dir), "utf8"), `${body.since}\n`);
    }),
  );

  it.effect("the status shows the pause, and resume removes it", () =>
    serving({ status: running }, async (call, { tokens, dir }) => {
      await call("POST", "/api/factory/claims/pause", tokens.operate);
      const paused = await json(await call("GET", STATUS_PATH, tokens.read));
      assert.isNotNull(paused.paused_by_hand);

      const resumed = await call("POST", "/api/factory/claims/resume", tokens.operate);
      assert.strictEqual(resumed.status, 200);
      assert.deepStrictEqual(await resumed.json(), {
        paused: false,
        already: false,
        message: "claims resumed",
      });
      assert.isFalse(NodeFS.existsSync(pauseFile(dir)));
      assert.isNull((await json(await call("GET", STATUS_PATH, tokens.read))).paused_by_hand);

      const again = await call("POST", "/api/factory/claims/resume", tokens.operate);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual(await again.json(), {
        paused: false,
        already: true,
        message: "claims were not paused",
      });
    }),
  );

  it.effect("answers 500 factory_error when the factory dir cannot be written", () =>
    serving({ dir: NodePath.join(tempDir("missing"), "nope") }, async (call, { tokens }) => {
      const response = await call("POST", "/api/factory/claims/pause", tokens.operate);
      assert.strictEqual(response.status, 500);
      assert.strictEqual((await json(response)).code, "factory_error");
    }),
  );
});

describe("an auth failure inside T3", () => {
  it.effect("answers 500 internal_error, not 401, and never runs the handler", () => {
    let handled = false;
    const failingRoute = route(
      "GET",
      "/api/factory/test/internal",
      AuthOrchestrationReadScope,
      Effect.sync(() => {
        handled = true;
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
    return Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const context = worldContext(
        {
          ...auth,
          authenticateHttpRequest: () =>
            Effect.fail(
              new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
                cause: new Error("session store unreadable"),
              }),
            ),
        },
        {},
        tempDir("factory"),
        { count: 0 },
      );
      const layer = failingRoute.pipe(Layer.provideMerge(layerRoutes));
      const response = yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
        ({ handler }) =>
          Effect.promise(() =>
            handler(new Request("http://127.0.0.1/api/factory/test/internal"), context),
          ),
        ({ dispose }) => Effect.promise(dispose),
      );
      assert.strictEqual(response.status, 500);
      const body = (yield* Effect.promise(() => response.json())) as { code: string };
      assert.strictEqual(body.code, "internal_error");
      assert.isFalse(handled);
    }).pipe(Effect.provide(layerEnvironmentAuth));
  });
});

describe("/api/factory/config", () => {
  const COMMENTED = `# the factory on this machine
gh_config_dir: /gh # login
poll_seconds: 60
max_concurrent_runs: 1
model: claude-sonnet-5-5
# stays a hand edit
notify: false
repos:
  - repo: rawphp/softfac
    path: /softfac
`;
  const configFile = (dir: string) => NodePath.join(dir, "config.yml");
  const fileText = (dir: string) => NodeFS.readFileSync(configFile(dir), "utf8");
  const VALID_BODY = {
    gh_config_dir: "/gh",
    poll_seconds: 30,
    max_concurrent_runs: 2,
    max_concurrent_gates: 2,
    model_instance: "claudeAgent",
    model: "claude-opus-4-8",
    repos: [{ repo: "a/b", path: "/b" }],
  };

  it.effect("GET reports a commented file: its values, and that it exists", () =>
    serving({}, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED);
      const response = await call("GET", CONFIG_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await json(response), {
        file: configFile(dir),
        exists: true,
        config: {
          gh_config_dir: "/gh",
          poll_seconds: 60,
          max_concurrent_runs: 1,
          max_concurrent_gates: 2,
          model_instance: "claudeAgent",
          model: "claude-sonnet-5-5",
          repos: [{ repo: "rawphp/softfac", path: "/softfac" }],
        },
        errors: [],
        repos: [{ repo: "rawphp/softfac", path: "/softfac", factory: null, errors: null }],
      });
    }),
  );

  it.effect("GET with no file reports exists false and the defaults", () =>
    serving({}, async (call, { tokens, dir }) => {
      const body = await json(await call("GET", CONFIG_PATH, tokens.read));
      assert.strictEqual(body.exists, false);
      assert.strictEqual(body.file, configFile(dir));
      assert.deepStrictEqual(body.config, {
        gh_config_dir: "",
        poll_seconds: 60,
        max_concurrent_runs: 1,
        max_concurrent_gates: 2,
        model_instance: "claudeAgent",
        model: "",
        repos: [],
      });
      assert.deepStrictEqual(body.errors, []);
    }),
  );

  it.effect("GET on an invalid file reports no config and the errors", () =>
    serving({}, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED.replace("model: claude-sonnet-5-5\n", ""));
      const body = await json(await call("GET", CONFIG_PATH, tokens.read));
      assert.strictEqual(body.exists, true);
      assert.strictEqual(body.config, null);
      assert.deepStrictEqual(body.errors, [
        { file: configFile(dir), field: "model", message: "is missing" },
      ]);
    }),
  );

  const project = {
    instructors: ["i"],
    base: "main",
    provision: [],
    gate: ["g"],
    requiredChecks: ["ci"],
    limits: { minutes: 5, gateRetries: 1, regates: 2, checksMinutes: 3, interruptionResumes: 4 },
    autonomy: "pr",
  } as const;

  it.effect("GET joins what the loop last read of each repo", () =>
    serving(
      {
        readings: new Map<string, RepoConfigReading>([
          ["rawphp/softfac", { kind: "ok", project }],
          ["a/b", { kind: "errors", errors: [{ file: ".dw/config.yml", message: "cannot read" }] }],
        ]),
      },
      async (call, { tokens, dir }) => {
        NodeFS.writeFileSync(
          configFile(dir),
          COMMENTED + "  - repo: a/b\n    path: /b\n  - repo: c/d\n    path: /d\n",
        );
        const body = await json(await call("GET", CONFIG_PATH, tokens.read));
        assert.deepStrictEqual(body.repos, [
          {
            repo: "rawphp/softfac",
            path: "/softfac",
            factory: {
              instructors: ["i"],
              base: "main",
              provision: [],
              gate: ["g"],
              required_checks: ["ci"],
              limits: {
                minutes: 5,
                gate_retries: 1,
                regates: 2,
                checks_minutes: 3,
                interruption_resumes: 4,
              },
              autonomy: "pr",
            },
            errors: null,
          },
          {
            repo: "a/b",
            path: "/b",
            factory: null,
            errors: [{ file: ".dw/config.yml", message: "cannot read" }],
          },
          { repo: "c/d", path: "/d", factory: null, errors: null },
        ]);
      },
    ),
  );

  it.effect("PUT needs settings:write: read and operate sessions are refused, file untouched", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED);
      for (const token of [tokens.read, tokens.operate]) {
        const response = await call("PUT", CONFIG_PATH, token, VALID_BODY);
        assert.strictEqual(response.status, 403);
        assert.strictEqual((await json(response)).code, "insufficient_scope");
      }
      assert.strictEqual(fileText(dir), COMMENTED);
      assert.strictEqual(wakes.reloads, 0);
    }),
  );

  it.effect(
    "PUT with an invalid body answers 422 with a field on each error and writes nothing",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        NodeFS.writeFileSync(configFile(dir), COMMENTED);
        const response = await call("PUT", CONFIG_PATH, tokens.settingsWrite, {
          poll_seconds: 5,
          model: "",
          repos: [],
        });
        assert.strictEqual(response.status, 422);
        const body = await json(response);
        assert.strictEqual(body.code, "invalid_config");
        const errors = body.errors as ReadonlyArray<{ field?: string }>;
        assert.deepStrictEqual(errors.map((e) => e.field).sort(), [
          "model",
          "poll_seconds",
          "repos",
        ]);
        assert.strictEqual(fileText(dir), COMMENTED);
        assert.strictEqual(wakes.reloads, 0);
        assert.deepStrictEqual(NodeFS.readdirSync(dir), ["config.yml"]);
      }),
  );

  it.effect("PUT with a body that is not a JSON object answers 400", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      for (const body of ["not json", "[1]", "null", '"x"']) {
        const response = await call("PUT", CONFIG_PATH, tokens.settingsWrite, body);
        assert.strictEqual(response.status, 400, body);
        assert.strictEqual((await json(response)).code, "invalid_body");
      }
      assert.isFalse(NodeFS.existsSync(configFile(dir)));
      assert.strictEqual(wakes.reloads, 0);
    }),
  );

  it.effect("PUT on a missing file creates it, reloads the loop and answers the new report", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      const response = await call("PUT", CONFIG_PATH, tokens.settingsWrite, VALID_BODY);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.strictEqual(body.exists, true);
      assert.deepStrictEqual(body.config, VALID_BODY);
      assert.strictEqual(wakes.reloads, 1);
      assert.include(fileText(dir), "claude-opus-4-8");
      assert.deepStrictEqual(NodeFS.readdirSync(dir), ["config.yml"]);
    }),
  );

  it.effect("PUT keeps the comments and the keys the form does not edit", () =>
    serving({}, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED);
      const response = await call("PUT", CONFIG_PATH, tokens.settingsWrite, { poll_seconds: 90 });
      assert.strictEqual(response.status, 200);
      const text = fileText(dir);
      assert.include(text, "# the factory on this machine");
      assert.include(text, "# login");
      assert.include(text, "# stays a hand edit\nnotify: false");
      assert.include(text, "poll_seconds: 90");
    }),
  );
});
