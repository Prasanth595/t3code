// @effect-diagnostics nodeBuiltinImport:off - the host name goes on every `claimed` line, as softfac writes it; a gate lock is a file.
// @effect-diagnostics globalDate:off - the ledger stamps lines with the wall clock, as softfac does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { loadHandPause } from "./claims.ts";
import {
  formatConfigError,
  loadMachineConfig,
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type MachineConfig,
  type ProjectConfig,
  type WatchedRepo,
} from "./config.ts";
import { clearGateLocks, gateLockFile } from "./gate.ts";
import { ledgerCall as ledger } from "./ledger/errors.ts";
import { makeCause, type MachineEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { listUnfinishedRuns } from "./ledger/listRuns.ts";
import { MachineLog } from "./ledger/machineLog.ts";
import { runLoop, type Loop } from "./loop.ts";
import { runPass, type PassError, type PassWorld, type Repo } from "./pass.ts";
import * as Process from "./process.ts";
import { FactoryProcess } from "./process.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { start, utcSecond, type Tracker } from "./runner/start.ts";
import * as Paths from "./t3/paths.ts";
import { bindProcess, makeGitHub, type GitHubError, type IssueSummary } from "./tracker/github.ts";

/** The running factory, for the code that wakes it (a thread's run changing, a person's request). */
export class FactoryLoop extends Context.Service<FactoryLoop, Loop>()("t3/factory/FactoryLoop") {}

/** A loop that does nothing: the factory has no config, or one it cannot read. */
const idle: Loop = { wake: Effect.void, awaitPass: Effect.never };

/**
 * How long an issue must have sat in `factory:triage` or `factory:building` with no assignee
 * before the pass treats it as a claim that was cut short: long enough that a claim in flight
 * (the label is swapped and the assignee follows within seconds) is never raced.
 */
const CLAIM_GRACE_MS = 15 * 60 * 1000;

const asPassError =
  (kind: PassError["kind"], prefix = "") =>
  (error: { readonly message: string }): PassError => ({
    kind,
    message: `${prefix}${error.message}`,
  });

const byNumber = (a: number, b: number) => a - b;

/** The numbers of the issues nobody is assigned to, by number. */
const unassignedByNumber = (items: ReadonlyArray<IssueSummary>) =>
  items
    .filter((item) => item.assignees.length === 0)
    .map((item) => item.number)
    .sort(byNumber);

/** The numbers of the issues `user` is the only assignee of, by number. */
const assignedOnlyTo = (items: ReadonlyArray<IssueSummary>, user: string) =>
  items
    .filter(
      (item) =>
        item.assignees.length === 1 && item.assignees[0]!.toLowerCase() === user.toLowerCase(),
    )
    .map((item) => item.number)
    .sort(byNumber);

/**
 * The project config of a repo: `.dw/config.yml` at the tip of the default branch on GitHub.
 * The config must name that branch as its `base`: it is committed on its own base branch.
 */
const projectFromBase = (
  github: ReturnType<typeof makeGitHub>,
): Effect.Effect<ProjectConfig, PassError, FactoryProcess> =>
  Effect.gen(function* () {
    const found = yield* github
      .baseConfig()
      .pipe(
        Effect.mapError(asPassError("config", `cannot read ${PROJECT_CONFIG_PATH} from GitHub: `)),
      );
    const file = `${found.branch}:${PROJECT_CONFIG_PATH}`;
    const parsed = parseProjectConfig(found.text, file);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail<PassError>({
        kind: "config",
        message: parsed.failure.map(formatConfigError).join("; "),
      });
    }
    if (parsed.success.base !== found.branch) {
      return yield* Effect.fail<PassError>({
        kind: "config",
        message: `${file} names base \`${parsed.success.base}\`, but the repo's default branch is \`${found.branch}\`: the config must be committed on its own base branch`,
      });
    }
    return parsed.success;
  });

/** The pass over this machine: GitHub through `gh`, the ledger under `dataDir`, the wall clock. */
export const liveWorld = (
  machine: MachineConfig,
  dataDir: string,
  process: FactoryProcess["Service"],
  clock: () => number,
  host: string,
): PassWorld => {
  const withProcess = <A, E>(effect: Effect.Effect<A, E, FactoryProcess>) =>
    Effect.provideService(effect, FactoryProcess, process);
  const githubFor = (watched: WatchedRepo) =>
    makeGitHub({ repo: watched.repo, ghConfigDir: machine.ghConfigDir });
  const trackerFor = (watched: WatchedRepo): Tracker => bindProcess(githubFor(watched), process);
  const tracker = (effect: Effect.Effect<unknown, GitHubError, FactoryProcess>) =>
    withProcess(effect).pipe(Effect.mapError(asPassError("tracker")));
  return {
    project: (watched) => withProcess(projectFromBase(githubFor(watched))),
    trackerUser: (watched) =>
      withProcess(githubFor(watched).login()).pipe(Effect.mapError(asPassError("tracker"))),
    unfinishedRuns: (only) => ledger(() => listUnfinishedRuns(dataDir, only)),
    readyIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).listIssues("ready")).pipe(
        Effect.map((listing) => ({ items: unassignedByNumber(listing.items), cut: listing.cut })),
        Effect.mapError(asPassError("tracker")),
      ),
    triageIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).listIssues("triage")).pipe(
        Effect.map((listing) => ({
          items: assignedOnlyTo(listing.items, repo.trackerUser),
          cut: listing.cut,
        })),
        Effect.mapError(asPassError("tracker")),
      ),
    unassignedClaims: (repo: Repo) =>
      withProcess(
        githubFor(repo.watched).unassignedClaims(
          utcSecond(clock() - CLAIM_GRACE_MS),
          repo.trackerUser,
        ),
      ).pipe(Effect.mapError(asPassError("tracker"))),
    releaseClaim: (repo: Repo, issue: number) => {
      const gh = githubFor(repo.watched);
      return tracker(
        gh
          .setState(issue, "proposed")
          .pipe(Effect.andThen(gh.postComment(issue, CUT_SHORT_COMMENT))),
      ).pipe(Effect.asVoid);
    },
    openBlockers: (repo: Repo, issue: number) =>
      withProcess(githubFor(repo.watched).openBlockers(issue)).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    dependsOnBlockers: (repo: Repo, issue: number) =>
      withProcess(githubFor(repo.watched).textBlockers(issue)).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    start: (repo: Repo, issue: number) =>
      start(
        {
          repo: repo.watched.repo,
          trackerUser: repo.trackerUser,
          machine: host,
          project: repo.project,
          dataDir,
          tracker: trackerFor(repo.watched),
          clock,
        },
        issue,
      ),
    gateRunning: (run) => NodeFS.existsSync(gateLockFile(dataDir, run)),
    recordError: (run, step, kind, message) =>
      ledger(() => {
        const out = Ledger.open(dataDir, run, { clock });
        try {
          out.append(
            { event: "error", data: { step, kind, message } },
            makeCause(step, "step-failed"),
          );
        } finally {
          out.close();
        }
      }),
    handPause: () => loadHandPause(dataDir),
    nowMs: clock,
    record: (event: MachineEvent) =>
      ledger(() => {
        const log = MachineLog.open(dataDir, { clock });
        try {
          log.append(event);
        } finally {
          log.close();
        }
      }),
  };
};

const hostName = (): string => {
  try {
    return NodeOS.hostname() || "unknown";
  } catch {
    return "unknown";
  }
};

const startFactory = Effect.gen(function* () {
  const { factoryDir, machineConfigPath } = yield* Paths.FactoryPaths;
  // Gates run inside this server, so a lock file left from an earlier run belongs to a dead gate.
  const cleared = yield* clearGateLocks(factoryDir);
  if (cleared > 0) yield* Effect.logInfo(`cleared ${cleared} gate lock(s)`);
  const loaded = yield* Effect.result(loadMachineConfig(machineConfigPath));
  if (Result.isFailure(loaded)) {
    for (const error of loaded.failure.errors) {
      yield* Effect.logError(formatConfigError(error));
    }
    return idle;
  }
  if (Option.isNone(loaded.success)) {
    yield* Effect.logInfo(`no factory config at ${machineConfigPath}`);
    return idle;
  }
  const machine = loaded.success.value;
  yield* Effect.logInfo("factory started");
  const process = yield* FactoryProcess;
  const world = liveWorld(machine, factoryDir, process, () => Date.now(), hostName());
  const onePass = Effect.gen(function* () {
    // Each line is logged as it is decided, so a pass that hangs or dies has said what it did.
    const context = yield* Effect.context<never>();
    const log = Effect.runSyncWith(context);
    return yield* runPass(world, machine, (line) => log(Effect.logInfo(line)));
  });
  return yield* runLoop(onePass, machine.pollSeconds);
});

/**
 * Needs FactoryPaths, FactoryProcess and FileSystem; what index.test.ts builds with a test
 * FactoryPaths and a fake FactoryProcess.
 */
export const FactoryRuntime = Layer.effect(FactoryLoop, startFactory);

/** The factory's root layer. server.ts merges it into the runtime; nothing else imports it. */
export const FactoryLayer = FactoryRuntime.pipe(
  Layer.provide(Paths.layer),
  Layer.provide(Process.layer),
);
