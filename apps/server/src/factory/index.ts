// @effect-diagnostics nodeBuiltinImport:off - the host name goes on every `claimed` line, as softfac writes it; a gate lock is a file.
// @effect-diagnostics globalDate:off - the ledger stamps lines with the wall clock, as softfac does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

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
import * as Gate from "./gate.ts";
import { FactoryGate, clearGateLocks, gateLockFile } from "./gate.ts";
import type { State } from "./domain/lifecycle.ts";
import { ledgerCall as ledger, type LedgerError } from "./ledger/errors.ts";
import { makeCause, type CauseStep, type ErrorKind, type MachineEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { listUnfinishedRuns } from "./ledger/listRuns.ts";
import { readRun } from "./ledger/read.ts";
import { runIdToString, type RunId } from "./ledger/runId.ts";
import { MachineLog } from "./ledger/machineLog.ts";
import { runLoop, type Loop } from "./loop.ts";
import { runPass, type GateStart, type PassError, type PassWorld, type Repo } from "./pass.ts";
import * as Process from "./process.ts";
import { FactoryProcess } from "./process.ts";
import { readProgress } from "./runner/progress.ts";
import { advance, timeLimit, watch, type BuildingContext } from "./runner/building.ts";
import {
  gate as gateStep,
  type GateContext,
  type GateStep,
  type GateStepError,
} from "./runner/gating.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { isOurs, newestSays, resume, start, utcSecond, type StartContext } from "./runner/start.ts";
import * as Events from "./t3/events.ts";
import * as Paths from "./t3/paths.ts";
import * as T3Sessions from "./t3/sessions.ts";
import {
  bindProcess,
  ClaimMemo,
  makeGitHub,
  type GitHubError,
  type IssueSummary,
} from "./tracker/github.ts";

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
    .filter((item) => isOurs(item.assignees, user))
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

/** What the live world runs its gates with, and what it does when one ends. */
export interface LiveGate {
  readonly gate: FactoryGate["Service"];
  /** Run when a gate ends, so the next pass carries on at once. */
  readonly wake: Effect.Effect<void>;
}

/** The run's line when its gate, started in the background, has ended. */
const gateWords = (run: string, step: GateStep): string => {
  switch (step.kind) {
    case "passed":
      return "the gate passed and the pull request is ready for review";
    case "sent-back":
      return `the gate failed on attempt ${step.attempt} and was sent back into the session`;
    case "stuck":
      return `stuck, the reason is in the ledger of run ${run}`;
    case "not-ready":
      return "nothing to gate";
    case "ended":
      return "the pull request was merged or closed, the run is finished";
    case "running":
      return "gate running";
    case "queued":
      return `gate queued: ${step.running} gates running, max_concurrent_gates is ${step.max}`;
  }
};

/** What a gate error was about, for the run's `error` line. */
const gateErrorKind = (error: GateStepError): ErrorKind => {
  switch (error._tag) {
    case "WorkspaceFailedError":
    case "WorkspaceUnexpectedError":
    case "WorkspaceCleanupError":
    case "WorkspaceIoError":
    case "WorkspaceSpawnError":
      return "git";
    case "GateCommandSpawnError":
    case "GateRecordError":
      return "gate";
    case "NoGateCommandsError":
    case "WrongRepoError":
      return "config";
    case "GitHubSpawnError":
    case "GitHubInvalidArgument":
    case "GitHubFailed":
    case "GitHubTimedOut":
    case "GitHubOutputTooLarge":
    case "GitHubParse":
    case "GitHubRateLimited":
      return "tracker";
    case "FactorySessionsError":
    case "FactoryThreadNotFoundError":
    case "FactoryMessageRejectedError":
      return "t3";
    default:
      return "ledger";
  }
};

/** The pass over this machine: GitHub through `gh`, the ledger under `dataDir`, the wall clock. */
export const liveWorld = (
  machine: MachineConfig,
  dataDir: string,
  process: FactoryProcess["Service"],
  sessions: T3Sessions.FactorySessions["Service"],
  clock: () => number,
  host: string,
  live: LiveGate,
): PassWorld => {
  // Built once per process, so judgements last as long as the factory runs.
  const claimMemo = new ClaimMemo();
  // The runs whose gate this process is running now: a gate holds the run's lock file only
  // while an attempt runs, and this covers the whole call.
  const gating = new Set<string>();
  const withProcess = <A, E>(effect: Effect.Effect<A, E, FactoryProcess>) =>
    Effect.provideService(effect, FactoryProcess, process);
  const githubFor = (watched: WatchedRepo) =>
    makeGitHub({ repo: watched.repo, ghConfigDir: machine.ghConfigDir });
  const trackerFor = (watched: WatchedRepo) => bindProcess(githubFor(watched), process);
  const tracker = (effect: Effect.Effect<unknown, GitHubError, FactoryProcess>) =>
    withProcess(effect).pipe(Effect.mapError(asPassError("tracker")));
  const startContext = (repo: Repo): StartContext => ({
    repo: repo.watched.repo,
    trackerUser: repo.trackerUser,
    machine: host,
    project: repo.project,
    dataDir,
    tracker: trackerFor(repo.watched),
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    model: { instanceId: machine.modelInstance, model: machine.model },
    sessions,
    clock,
  });
  const buildingContext = (repo: Repo): BuildingContext => ({
    repo: repo.watched.repo,
    trackerUser: repo.trackerUser,
    machine: host,
    project: repo.project,
    dataDir,
    tracker: trackerFor(repo.watched),
    sessions,
    clock,
  });
  const gateContext = (repo: Repo): GateContext => ({
    ...buildingContext(repo),
    tracker: trackerFor(repo.watched),
    gate: live.gate,
    maxConcurrentGates: machine.maxConcurrentGates,
    gateOptions: { ghConfigDir: machine.ghConfigDir, clock },
  });
  const recordError = (run: RunId, step: CauseStep, kind: ErrorKind, message: string) =>
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
    });
  /**
   * The gate as a background fiber: its line is logged when it ends, as the pass's lines are, an
   * error goes to the run's ledger, and the loop is woken so the next pass carries on at once.
   */
  const startGate = (repo: Repo, run: RunId): Effect.Effect<GateStart> =>
    Effect.gen(function* () {
      const id = runIdToString(run);
      if (gating.size >= machine.maxConcurrentGates) {
        return { kind: "queued", running: gating.size, max: machine.maxConcurrentGates } as const;
      }
      gating.add(id);
      const label = `${repo.watched.repo}#${run.issue}`;
      yield* gateStep(gateContext(repo), run).pipe(
        Effect.matchEffect({
          onSuccess: (step) => Effect.logInfo(`${label} building: ${gateWords(id, step)}`),
          onFailure: (error) =>
            Effect.logError(`error: ${label} gate: ${error.message}`).pipe(
              Effect.andThen(
                recordError(run, "gate", gateErrorKind(error), error.message).pipe(
                  Effect.catch((failed) =>
                    Effect.logError(
                      `error: ${label} gate: cannot record the error: ${failed.message}`,
                    ),
                  ),
                ),
              ),
            ),
        }),
        Effect.ensuring(Effect.sync(() => gating.delete(id))),
        Effect.andThen(live.wake),
        Effect.forkDetach,
      );
      return { kind: "started" } as const;
    });
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
    unassignedClaims: (repo: Repo, known: ReadonlySet<number>) =>
      withProcess(
        githubFor(repo.watched).unassignedClaims(
          utcSecond(clock() - CLAIM_GRACE_MS),
          repo.trackerUser,
          known,
          claimMemo,
        ),
      ).pipe(
        Effect.map((scan) => ({
          claims: scan.claims,
          unread: scan.unread.map((u) => ({ issue: u.issue, message: u.error.message })),
        })),
        Effect.mapError(asPassError("tracker")),
      ),
    // The comment first, then the label, as a refusal does: a label call that fails leaves the
    // issue where a later pass finds it again. The comment counts as already posted, as
    // `alreadySaid` counts a refusal, only when it is the issue's newest factory comment and was
    // created after the label event that began this claim; an older one explained an earlier
    // claim. A label time that cannot be read posts the comment: at-least-once beats an
    // unexplained move.
    releaseClaim: (repo: Repo, issue: number, from: State) => {
      const gh = githubFor(repo.watched);
      return tracker(
        Effect.gen(function* () {
          const newest = yield* gh.newestFactoryComment(issue);
          let explained = false;
          if (newestSays(newest, CUT_SHORT_COMMENT)) {
            const labeled = yield* Effect.result(gh.labeledAt(issue, from));
            explained =
              Result.isSuccess(labeled) &&
              labeled.success !== null &&
              newest.createdAt > labeled.success;
          }
          if (!explained) yield* gh.postComment(issue, CUT_SHORT_COMMENT);
          yield* gh.setState(issue, "proposed");
        }),
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
    start: (repo: Repo, issue: number) => start(startContext(repo), issue),
    resume: (repo: Repo, issue: number) => resume(startContext(repo), issue),
    timeLimit: (repo, run) => timeLimit(buildingContext(repo), run),
    watch: (repo, run) => watch(buildingContext(repo), run),
    advance: (repo, run) => advance(buildingContext(repo), run),
    gateRunning: (run) =>
      gating.has(runIdToString(run)) || NodeFS.existsSync(gateLockFile(dataDir, run)),
    gate: startGate,
    recordError,
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

/**
 * The threads the unfinished runs under `dataDir` name as their sessions'. A run whose file
 * cannot be read names none.
 */
export const ownedThreads = (dataDir: string): Effect.Effect<ReadonlySet<string>, LedgerError> =>
  ledger(() => {
    const ids = new Set<string>();
    for (const info of listUnfinishedRuns(dataDir)) {
      if (info.unreadable || !info.session) continue;
      try {
        const threadId = readProgress(readRun(dataDir, info.id).entries).threadId;
        if (threadId !== null) ids.add(threadId);
      } catch {
        // Unreadable since it was listed: the next refresh reads it again.
      }
    }
    return ids;
  });

/**
 * Reads the owned threads again into `owned`. A listing that fails is logged and keeps the set
 * it had: the next refresh, or the next scheduled pass, covers what it missed.
 */
const refreshOwned = (dataDir: string, owned: Ref.Ref<ReadonlySet<string>>) =>
  ownedThreads(dataDir).pipe(
    Effect.flatMap((ids) => Ref.set(owned, ids)),
    Effect.catch((error) =>
      Effect.logWarning(`factory cannot list the threads it owns: ${error.message}`),
    ),
  );

/**
 * Runs one events stream to its end, waking for each thread in `owned`. A lookup is a set read,
 * so the many events of threads the factory does not own cost nothing. The stream's own failure
 * is the caller's to handle.
 */
export const wakeOn = (
  owned: Ref.Ref<ReadonlySet<string>>,
  events: Stream.Stream<string, Events.EventsError>,
  wake: Effect.Effect<void>,
): Effect.Effect<void, Events.EventsError> =>
  Stream.runForEach(events, (threadId) =>
    Effect.flatMap(Ref.get(owned), (ids) => (ids.has(threadId) ? wake : Effect.void)),
  );

/**
 * Wakes the loop when T3 says the latest run of a thread the factory owns changed status. A
 * stream that ends or fails is run again after `restartDelay`; the status changes in the gap are
 * not replayed, and the next pass reads them.
 */
const wakeOnOwnedThreads = (
  owned: Ref.Ref<ReadonlySet<string>>,
  loop: Loop,
  restartDelay: Duration.Input,
) =>
  Effect.gen(function* () {
    const events = yield* Events.FactoryEvents;
    return yield* wakeOn(owned, events.runStatusChanges, loop.wake).pipe(
      Effect.catch((error) => Effect.logWarning("factory events stream failed, restarting", error)),
      Effect.andThen(Effect.sleep(restartDelay)),
      Effect.forever,
    );
  });

/** What the factory's runtime can be told, for a test that cannot wait. */
export interface RuntimeOptions {
  /** How long to wait before the events stream is run again. Default 5 seconds. */
  readonly restartDelay?: Duration.Input;
}

const startFactory = (options: RuntimeOptions) =>
  Effect.gen(function* () {
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
    const sessions = yield* T3Sessions.FactorySessions;
    const gate = yield* FactoryGate;
    // The loop is made after the world, so a gate that ends wakes whatever loop there is then.
    let running: Loop | null = null;
    const world = liveWorld(machine, factoryDir, process, sessions, () => Date.now(), hostName(), {
      gate,
      wake: Effect.suspend(() => running?.wake ?? Effect.void),
    });
    // The threads of the unfinished runs, read at start and after every pass: a pass is what
    // launches and finishes sessions, so between passes the set does not change.
    const owned = yield* Ref.make<ReadonlySet<string>>(new Set());
    yield* refreshOwned(factoryDir, owned);
    const onePass = Effect.gen(function* () {
      // Each line is logged as it is decided, so a pass that hangs or dies has said what it did.
      const context = yield* Effect.context<never>();
      const log = Effect.runSyncWith(context);
      return yield* runPass(world, machine, (line) => log(Effect.logInfo(line)));
    }).pipe(Effect.ensuring(refreshOwned(factoryDir, owned)));
    const loop = yield* runLoop(onePass, machine.pollSeconds);
    running = loop;
    yield* Effect.forkScoped(wakeOnOwnedThreads(owned, loop, options.restartDelay ?? "5 seconds"));
    return loop;
  });

/**
 * Needs FactoryPaths, FactoryProcess, FactorySessions, FactoryEvents, FactoryGate and FileSystem;
 * what index.test.ts builds with a test FactoryPaths, a fake FactoryProcess, a stub
 * FactorySessions, a FactoryEvents it feeds by hand and a gate that never runs.
 */
export const factoryRuntime = (options: RuntimeOptions = {}) =>
  Layer.effect(FactoryLoop, startFactory(options));

export const FactoryRuntime = factoryRuntime();

/** The factory's root layer. server.ts merges it into the runtime; nothing else imports it. */
export const FactoryLayer = FactoryRuntime.pipe(
  Layer.provide(Paths.layer),
  Layer.provide(Gate.layer),
  Layer.provide(Process.layer),
  Layer.provide(T3Sessions.layerLive),
  Layer.provide(Events.layerLive),
);
