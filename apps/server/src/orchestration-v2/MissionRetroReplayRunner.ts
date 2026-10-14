// @effect-diagnostics nodeBuiltinImport:off -- the runner hashes snapshot/fixture bytes and manages private sandbox directories.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { NonNegativeInt } from "../../../../packages/contracts/src/baseSchemas.ts";
import { RetroId, Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import { SkillEvaluationTargetSkillRef } from "../../../../packages/contracts/src/missionRetroSkillEvaluation.ts";
import {
  MAX_SKILL_REPLAY_REPEAT_COUNT,
  commitSkillReplayEvidence,
  type SkillReplayEvidenceCommitted,
  type SkillReplayEvidenceEnvelope,
} from "./MissionRetroReplayArtifacts.ts";

/**
 * Real isolated replay execution for one skill candidate (P2).
 *
 * The runner executes a strictly configured, root-approved executor over
 * runner-owned COPIES of the old and new skill snapshots and matched
 * fixtures, once per fixture class, sample and side, then commits a
 * hash-bound evidence envelope. It decides nothing: the existing pure
 * validator and the accepted recorder read the envelope later.
 *
 * What the runner establishes itself, from bytes it read:
 * - the old/new snapshot digests (also re-read after every run, so an
 *   executor that mutates its snapshot or fixture is `isolation_violated`),
 * - the fixture identity (spec + input digests) and the executor config
 *   digest (executable bytes, pinned files, args, env, route, limits),
 * - outcome, by grading the executor's answer against expected strings the
 *   executor never saw (the spec is never copied into a sandbox),
 * - leakage, by scanning everything the executor can see for expected
 *   strings, and independence, because the root-supplied reviewer identity
 *   must differ from the author.
 *
 * What the executor attests, and the runner only cross-checks: which skill
 * files it read. Each claimed read must name a file in the independently
 * computed manifest with its exact SHA-256, otherwise the run's telemetry is
 * `unknown` and the recorder holds. A model's prose is never telemetry.
 *
 * Proof class matters. A `deterministic_executable` proves the replay
 * pipeline and a deterministic behavior. Only a `model_backed` executor,
 * with a root-approved SUBSCRIPTION route and repeated stochastic samples,
 * can say anything about a real model effect. This slice never calls a model;
 * an API-billed route is not representable and credential-like environment
 * is refused, so nothing here can spend or leak API keys.
 *
 * Failures are bounded and typed. A crash, non-zero exit, timeout, output
 * flood or malformed result aborts the whole replay with no envelope, so a
 * missing run is never read as a pass. The child's whole process group dies
 * with its scope, on completion, failure, timeout or interruption, and the
 * sandbox is removed either way.
 */
export class MissionRetroReplayRunError extends Schema.TaggedError<MissionRetroReplayRunError>()(
  "MissionRetroReplayRunError",
  {
    category: Schema.Literals([
      "invalid_config",
      "invalid_request",
      "unsafe_input",
      "not_independent",
      "executor_unavailable",
      "executor_failed",
      "executor_timeout",
      "output_exceeded",
      "isolation_violated",
      "persistence",
    ]),
    /** Bounded run label only, never executor output. */
    runRef: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Skill replay failed (${this.category}).`;
  }
}
const isRunError = Schema.is(MissionRetroReplayRunError);

const runError = (
  category: MissionRetroReplayRunError["category"],
  detail: { readonly runRef?: string; readonly cause?: unknown } = {},
): MissionRetroReplayRunError =>
  new MissionRetroReplayRunError({
    category,
    ...(detail.runRef === undefined ? {} : { runRef: detail.runRef }),
    ...(detail.cause === undefined ? {} : { cause: detail.cause }),
  });

const FIXTURE_CLASSES = ["failure", "positive", "negative"] as const;
type FixtureClass = (typeof FIXTURE_CLASSES)[number];

const MAX_TREE_FILES = 256;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_DEPTH = 8;
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PINNED_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FORCE_KILL_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._@+ -]{1,128}$/;
const SAFE_REL_PATH = /^[A-Za-z0-9._@+ -]{1,128}(\/[A-Za-z0-9._@+ -]{1,128}){0,7}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|BEARER|AUTH)/;
// Best effort, not a secret scanner: well-known token shapes in env values and args.
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;

const Counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const boundedString = (max: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.length <= max && !value.includes("\0"), {
      expected: `a string up to ${max} chars without NUL`,
    }),
  );
const AbsolutePath = boundedString(1024).check(
  Schema.makeFilter((value) => NodePath.isAbsolute(value), { expected: "an absolute path" }),
);

const ReplayRoute = Schema.Struct({
  providerInstanceId: RetroId,
  model: RetroId,
  billing: Schema.Literal("subscription"),
});

const ExecutorConfigSchema = Schema.Struct({
  kind: Schema.Literals(["deterministic_executable", "model_backed"]),
  executable: AbsolutePath,
  args: Schema.Array(boundedString(4096)).check(
    Schema.makeFilter((args) => args.length <= 64, { expected: "at most 64 args" }),
  ),
  env: Schema.optional(Schema.Record(Schema.String, boundedString(4096))),
  pinnedFiles: Schema.optional(
    Schema.Array(AbsolutePath).check(
      Schema.makeFilter((files) => files.length <= 8, { expected: "at most 8 pinned files" }),
    ),
  ),
  route: Schema.optional(ReplayRoute),
  timeoutMs: Schema.optional(Counter),
  forceKillAfterMs: Schema.optional(Counter),
  maxOutputBytes: Schema.optional(Counter),
});

/** Root-approved executor. The candidate and the model never choose, extend or template it. */
export type ReplayExecutorConfig = typeof ExecutorConfigSchema.Type;

const RunnerConfigSchema = Schema.Struct({
  executor: ExecutorConfigSchema,
  /** Root-supplied independent reviewer/grader identity. Never read from a worker or a model. */
  reviewerId: RetroId,
  /** Private runner-owned directory for per-replay sandboxes. */
  sandboxRoot: AbsolutePath,
  /** Evidence root; the producer reads from the same one. */
  artifactDirectory: AbsolutePath,
  repeatCount: Counter,
});
export type MissionRetroReplayRunnerConfig = typeof RunnerConfigSchema.Type;

const RequestSchema = Schema.Struct({
  scope: Schema.Struct({
    teamId: RetroId,
    environmentId: RetroId,
    originMissionId: RetroId,
    candidateId: RetroId,
    targetSkillRef: SkillEvaluationTargetSkillRef,
    sourceReportHash: Sha256Hex,
    normalizedReportHash: Sha256Hex,
  }),
  evaluationId: RetroId,
  retroEpoch: Counter,
  /** Trusted author identity, supplied by the root. */
  authorId: RetroId,
  /** Root allowlist decision; only `owned` snapshots are replayed. */
  targetOwnership: Schema.Literals(["owned", "upstream", "unknown"]),
  /** UNTRUSTED author claim; preserved for the validator's cross-check and never used here. */
  candidateClaim: Schema.Struct({
    candidateId: RetroId,
    targetSkillRef: SkillEvaluationTargetSkillRef,
    sourceReportHash: Sha256Hex,
    claimedPass: Schema.Boolean,
  }),
  /** Source directories to copy from. They are only ever read. */
  snapshots: Schema.Struct({ old: AbsolutePath, new: AbsolutePath }),
  /** Fixture directories: `spec.json` (runner-private) and `input/` (executor-visible). */
  fixtures: Schema.Struct({
    failure: AbsolutePath,
    positive: AbsolutePath,
    negative: AbsolutePath,
  }),
});
export type MissionRetroReplayRequest = typeof RequestSchema.Type;

const FixtureSpecSchema = Schema.Struct({
  fixtureId: RetroId,
  expect: Schema.Struct({
    mustContain: Schema.Array(boundedString(512).check(Schema.isMinLength(8))).check(
      Schema.makeFilter((items) => items.length >= 1 && items.length <= 8, {
        expected: "1 to 8 expected strings of at least 8 chars",
      }),
    ),
    mustNotContain: Schema.Array(boundedString(512).check(Schema.isMinLength(1))).check(
      Schema.makeFilter((items) => items.length <= 8, { expected: "at most 8 forbidden strings" }),
    ),
  }),
  /** Skill files the task legitimately needs; any other verified load is unnecessary. */
  allowedSkillLoads: Schema.Array(Schema.String.check(Schema.isPattern(SAFE_REL_PATH))).check(
    Schema.makeFilter((items) => items.length <= 16, { expected: "at most 16 allowed loads" }),
  ),
});

const ExecutorResultSchema = Schema.Struct({
  completed: Schema.Boolean,
  answer: boundedString(32 * 1024),
  skillReads: Schema.Array(Schema.Struct({ path: boundedString(256), sha256: Sha256Hex })).check(
    Schema.makeFilter((reads) => reads.length <= 64, { expected: "at most 64 reads" }),
  ),
});

const decodeConfig = Schema.decodeUnknownSync(RunnerConfigSchema, { onExcessProperty: "error" });
const decodeRequest = Schema.decodeUnknownSync(RequestSchema, { onExcessProperty: "error" });
const decodeSpec = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSpecSchema), {
  onExcessProperty: "error",
});
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutorResultSchema), {
  onExcessProperty: "error",
});

const sha256Hex = (bytes: Uint8Array | string): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Filesystem: bounded trees, private copies, no symlinks, no escape
// ---------------------------------------------------------------------------

interface TreeEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

const unsafe = (cause?: unknown): MissionRetroReplayRunError => runError("unsafe_input", { cause });

const treeDigest = (entries: ReadonlyArray<TreeEntry>): string =>
  sha256Hex(stableStringify(entries));

const readNoFollow = async (path: string, limit: number): Promise<Buffer> => {
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > limit) throw unsafe();
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw unsafe();
    return bytes;
  } finally {
    await handle.close();
  }
};

/**
 * Walk a source or copy: only regular files and directories, safe names, hard
 * bounds, at least one file. A symlink, special file or oversized tree is
 * rejected, never followed or truncated.
 */
const walkTree = async (root: string): Promise<ReadonlyArray<TreeEntry>> => {
  const rootStatus = await NodeFSP.lstat(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) throw unsafe();
  const entries: Array<TreeEntry> = [];
  let total = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw unsafe();
    for (const name of await NodeFSP.readdir(directory)) {
      if (name === "." || name === ".." || !SAFE_NAME.test(name)) throw unsafe();
      const full = NodePath.join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const status = await NodeFSP.lstat(full);
      if (status.isSymbolicLink()) throw unsafe();
      if (status.isDirectory()) {
        await visit(full, relative, depth + 1);
      } else if (status.isFile()) {
        total += status.size;
        if (entries.length >= MAX_TREE_FILES || total > MAX_TREE_BYTES) throw unsafe();
        const bytes = await readNoFollow(full, MAX_TREE_BYTES);
        if (bytes.length !== status.size) throw unsafe();
        entries.push({ path: relative, sha256: sha256Hex(bytes), size: bytes.length });
      } else {
        throw unsafe();
      }
    }
  };
  await visit(root, "", 0);
  if (entries.length === 0) throw unsafe();
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

const lockTree = async (root: string, entries: ReadonlyArray<TreeEntry>): Promise<void> => {
  const directories = new Set<string>([root]);
  for (const entry of entries) {
    let parent = NodePath.dirname(NodePath.join(root, entry.path));
    while (parent !== root && !directories.has(parent)) {
      directories.add(parent);
      parent = NodePath.dirname(parent);
    }
  }
  // Deepest first so a parent is locked only after its children.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await NodeFSP.chmod(directory, 0o500);
  }
};

/**
 * Copy a walked source into a fresh private directory, re-walk the copy, and
 * require the same digest: a source mutated mid-copy is refused. The copy is
 * then made read-only. The source is never written.
 */
const copyTree = async (
  source: string,
  destination: string,
  expected: ReadonlyArray<TreeEntry>,
): Promise<ReadonlyArray<TreeEntry>> => {
  await NodeFSP.mkdir(destination, { mode: 0o700 });
  for (const entry of expected) {
    const target = NodePath.join(destination, entry.path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = await readNoFollow(NodePath.join(source, entry.path), MAX_TREE_BYTES);
    await NodeFSP.writeFile(target, bytes, { flag: "wx", mode: 0o400 });
  }
  const copied = await walkTree(destination);
  if (treeDigest(copied) !== treeDigest(expected)) throw runError("isolation_violated");
  await lockTree(destination, copied);
  return copied;
};

const makeWritable = async (directory: string): Promise<void> => {
  const status = await NodeFSP.lstat(directory).catch(() => null);
  if (status === null || status.isSymbolicLink() || !status.isDirectory()) return;
  await NodeFSP.chmod(directory, 0o700).catch(() => undefined);
  for (const child of await NodeFSP.readdir(directory).catch(() => [])) {
    await makeWritable(NodePath.join(directory, child));
  }
};

/** Sandbox removal never follows a symlink and is idempotent. */
const removeTree = async (directory: string): Promise<void> => {
  await makeWritable(directory);
  await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
};

/** The sandbox root must itself be a real private directory, never a symlink. */
const resolveSandboxRoot = async (root: string): Promise<string> => {
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
  });
  const status = await NodeFSP.lstat(root);
  if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o077) !== 0) {
    throw runError("invalid_config");
  }
  return NodeFSP.realpath(root);
};

const hashFile = (path: string, limit: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    let seen = 0;
    const stream = NodeFS.createReadStream(path);
    stream.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > limit) {
        stream.destroy(runError("executor_unavailable"));
        return;
      }
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

// ---------------------------------------------------------------------------
// Executor identity
// ---------------------------------------------------------------------------

interface PreparedExecutor {
  readonly config: ReplayExecutorConfig;
  readonly executable: string;
  readonly configDigest: string;
  readonly timeoutMs: number;
  readonly forceKillAfterMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

/** Static checks that need no filesystem; run when the layer is built. */
const validateConfig = (config: MissionRetroReplayRunnerConfig): void => {
  const { executor } = config;
  if (
    config.repeatCount < 1 ||
    config.repeatCount > MAX_SKILL_REPLAY_REPEAT_COUNT ||
    (executor.kind === "model_backed"
      ? executor.route === undefined || config.repeatCount < 2
      : executor.route !== undefined) ||
    config.reviewerId.length === 0
  ) {
    throw runError("invalid_config");
  }
  for (const [name, value] of Object.entries(executor.env ?? {})) {
    if (
      !ENV_NAME.test(name) ||
      name.startsWith("NOFUN_REPLAY_") ||
      SECRET_ENV_NAME.test(name) ||
      SECRET_VALUE.test(value)
    ) {
      throw runError("invalid_config");
    }
  }
  if (executor.args.some((arg) => SECRET_VALUE.test(arg))) throw runError("invalid_config");
  for (const [limit, min, max] of [
    [executor.timeoutMs, 1, 600_000],
    [executor.forceKillAfterMs, 1, 30_000],
    [executor.maxOutputBytes, 1, 8 * 1024 * 1024],
  ] as const) {
    if (limit !== undefined && (limit < min || limit > max)) throw runError("invalid_config");
  }
};

type FileKey = string;
const fileKeyOf = (real: string, status: NodeFS.Stats): FileKey =>
  `${real}:${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface MissionRetroReplayReceipt extends SkillReplayEvidenceCommitted {
  /** The committed envelope: digests, counters and ids only. */
  readonly envelope: SkillReplayEvidenceEnvelope;
  /** Executor runs actually performed (two per pair). */
  readonly runCount: number;
}

export class MissionRetroReplayRunner extends Context.Service<
  MissionRetroReplayRunner,
  {
    /**
     * Replay one candidate in isolation and commit the evidence envelope. The
     * result carries the exact ref and digest for the recorder command; it is
     * evidence, never a verdict, and never promotes or installs anything.
     */
    readonly replay: (
      request: MissionRetroReplayRequest,
    ) => Effect.Effect<MissionRetroReplayReceipt, MissionRetroReplayRunError>;
    /**
     * Digest of the approved executor config as the executor bytes are right
     * now. The root pins this in the evidence producer, so evidence made under
     * any other executor, argument, env or route is denied.
     */
    readonly configDigest: Effect.Effect<string, MissionRetroReplayRunError>;
  }
>()("t3/orchestration-v2/MissionRetroReplayRunner") {}

interface Source {
  readonly fixtureClass: FixtureClass;
  readonly directory: string;
  readonly spec: typeof FixtureSpecSchema.Type;
  readonly specSha256: string;
  readonly input: ReadonlyArray<TreeEntry>;
  readonly inputDigest: string;
  readonly fixtureHash: string;
}

interface Observation {
  readonly runRef: string;
  readonly contextId: string;
  readonly fixtureId: string;
  readonly fixtureHash: string;
  readonly configDigest: string;
  readonly observedSkillSha256: string;
  readonly outcome: "pass" | "fail";
  readonly skillTriggered: boolean;
  readonly unnecessaryLoads: number;
  readonly repeatedLookups: number;
  readonly completionQuality: "ok" | "degraded" | "unknown";
}

const loadSource = async (fixtureClass: FixtureClass, directory: string): Promise<Source> => {
  const status = await NodeFSP.lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) throw unsafe();
  const specBytes = await readNoFollow(NodePath.join(directory, "spec.json"), MAX_SPEC_BYTES);
  const spec = (() => {
    try {
      return decodeSpec(specBytes.toString("utf8"));
    } catch (cause) {
      throw unsafe(cause);
    }
  })();
  const input = await walkTree(NodePath.join(directory, "input"));
  const specSha256 = sha256Hex(specBytes);
  const inputDigest = treeDigest(input);
  return {
    fixtureClass,
    directory,
    spec,
    specSha256,
    input,
    inputDigest,
    fixtureHash: sha256Hex(stableStringify({ specSha256, inputDigest })),
  };
};

/** True when any expected string appears in anything the executor can see. */
const leaks = async (source: Source, executor: PreparedExecutor): Promise<boolean> => {
  const needles = source.spec.expect.mustContain;
  const visible: Array<string> = [...executor.config.args, ...Object.values(executor.env)];
  for (const entry of source.input) {
    const bytes = await readNoFollow(
      NodePath.join(source.directory, "input", entry.path),
      MAX_TREE_BYTES,
    );
    visible.push(bytes.toString("utf8"));
  }
  return needles.some((needle) => visible.some((text) => text.includes(needle)));
};

const resultStatus = async (outDirectory: string): Promise<Buffer> => {
  const directoryStatus = await NodeFSP.lstat(outDirectory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) throw unsafe();
  const file = NodePath.join(outDirectory, "result.json");
  const real = await NodeFSP.realpath(file);
  if (real !== NodePath.join(await NodeFSP.realpath(outDirectory), "result.json")) throw unsafe();
  return readNoFollow(file, MAX_RESULT_BYTES);
};

const make = (config: MissionRetroReplayRunnerConfig) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateConfig(config),
      catch: (cause) => (isRunError(cause) ? cause : runError("invalid_config", { cause })),
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executorKeys = new Map<string, string>();

    const hashCached = async (path: string, limit: number, key: FileKey): Promise<string> => {
      const known = executorKeys.get(key);
      if (known !== undefined) return known;
      const digest = await hashFile(path, limit);
      executorKeys.set(key, digest);
      return digest;
    };

    const prepareExecutor = (): Promise<PreparedExecutor> =>
      (async () => {
        const { executor } = config;
        const real = await NodeFSP.realpath(executor.executable);
        const status = await NodeFSP.stat(real);
        if (!status.isFile() || (status.mode & 0o111) === 0) {
          throw runError("executor_unavailable");
        }
        const executableSha = await hashCached(real, 1024 * 1024 * 1024, fileKeyOf(real, status));
        const pinned: Array<{ readonly path: string; readonly sha256: string }> = [];
        for (const file of [...(executor.pinnedFiles ?? [])].sort()) {
          const pinnedReal = await NodeFSP.realpath(file);
          const pinnedStatus = await NodeFSP.stat(pinnedReal);
          if (!pinnedStatus.isFile()) throw runError("executor_unavailable");
          pinned.push({
            path: pinnedReal,
            sha256: await hashCached(
              pinnedReal,
              MAX_PINNED_FILE_BYTES,
              fileKeyOf(pinnedReal, pinnedStatus),
            ),
          });
        }
        const timeoutMs = executor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const forceKillAfterMs = executor.forceKillAfterMs ?? DEFAULT_FORCE_KILL_MS;
        const maxOutputBytes = executor.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const env = executor.env ?? {};
        return {
          config: executor,
          executable: real,
          timeoutMs,
          forceKillAfterMs,
          maxOutputBytes,
          env,
          configDigest: sha256Hex(
            stableStringify({
              kind: executor.kind,
              executable: { path: real, sha256: executableSha },
              args: executor.args,
              env: Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)),
              pinned,
              route: executor.route ?? null,
              limits: { timeoutMs, forceKillAfterMs, maxOutputBytes },
            }),
          ),
        } satisfies PreparedExecutor;
      })();

    /** One isolated executor run on fresh private copies; returns its independently derived observation. */
    const executeRun = Effect.fn("MissionRetroReplayRunner.executeRun")(function* (input: {
      readonly executor: PreparedExecutor;
      readonly replayDirectory: string;
      readonly replayId: string;
      readonly sequence: number;
      readonly fixtureClass: FixtureClass;
      readonly side: "old" | "new";
      readonly sample: number;
      readonly skillSource: string;
      readonly skill: ReadonlyArray<TreeEntry>;
      readonly source: Source;
    }): Effect.fn.Return<Observation, MissionRetroReplayRunError> {
      const runRef = `replay:${input.replayId}:${input.fixtureClass}:${input.sample}:${input.side}`;
      const contextId = `ctx:${input.replayId}:${input.sequence}`;
      const guard = <A>(thunk: () => Promise<A>) =>
        Effect.tryPromise({
          try: thunk,
          catch: (cause) =>
            isRunError(cause) ? cause : runError("persistence", { runRef, cause }),
        });
      const runDirectory = NodePath.join(input.replayDirectory, `run-${input.sequence}`);
      const skillDirectory = NodePath.join(runDirectory, "skill");
      const inputDirectory = NodePath.join(runDirectory, "input");
      const outDirectory = NodePath.join(runDirectory, "out");
      const workDirectory = NodePath.join(runDirectory, "work");
      const skillDigest = treeDigest(input.skill);

      yield* guard(async () => {
        await NodeFSP.mkdir(runDirectory, { mode: 0o700 });
        await NodeFSP.mkdir(outDirectory, { mode: 0o700 });
        await NodeFSP.mkdir(workDirectory, { mode: 0o700 });
        await copyTree(input.skillSource, skillDirectory, input.skill);
        await copyTree(
          NodePath.join(input.source.directory, "input"),
          inputDirectory,
          input.source.input,
        );
      });

      const env = {
        TMPDIR: workDirectory,
        HOME: workDirectory,
        ...input.executor.env,
        NOFUN_REPLAY_SKILL_DIR: skillDirectory,
        NOFUN_REPLAY_INPUT_DIR: inputDirectory,
        NOFUN_REPLAY_OUT_DIR: outDirectory,
        NOFUN_REPLAY_RUN_REF: runRef,
      };
      const bounded =
        (stream: "stdout" | "stderr") => (source: Stream.Stream<Uint8Array, unknown>) => {
          let seen = 0;
          return source.pipe(
            Stream.runForEach((chunk) => {
              seen += chunk.length;
              return seen > input.executor.maxOutputBytes
                ? Effect.fail(runError("output_exceeded", { runRef }))
                : Effect.void;
            }),
            Effect.mapError((cause) =>
              isRunError(cause)
                ? cause
                : runError("executor_failed", { runRef, cause: { stream } }),
            ),
          );
        };

      const checkExecutor = guard(async () => {
        const current = await prepareExecutor();
        if (current.configDigest !== input.executor.configDigest) {
          throw runError("isolation_violated", { runRef });
        }
      });
      // Every pair must run under the same pinned executable/config bytes,
      // including changes made by an earlier side of the replay.
      yield* checkExecutor;
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner
            .spawn(
              ChildProcess.make(input.executor.executable, [...input.executor.config.args], {
                cwd: workDirectory,
                env,
                extendEnv: false,
                shell: false,
                stdin: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: Duration.millis(input.executor.forceKillAfterMs),
              }),
            )
            .pipe(Effect.mapError((cause) => runError("executor_failed", { runRef, cause })));
          const [, , exitCode] = yield* Effect.all(
            [
              bounded("stdout")(child.stdout),
              bounded("stderr")(child.stderr),
              child.exitCode.pipe(
                Effect.mapError((cause) => runError("executor_failed", { runRef, cause })),
              ),
            ],
            { concurrency: "unbounded" },
          );
          return exitCode;
        }),
      ).pipe(Effect.timeoutOption(Duration.millis(input.executor.timeoutMs)));
      if (Option.isNone(outcome)) return yield* runError("executor_timeout", { runRef });
      if (outcome.value !== 0) return yield* runError("executor_failed", { runRef });
      yield* checkExecutor;

      // Isolation: the executor's own copies must still be byte-identical.
      yield* guard(async () => {
        // An executor that changed its copies' structure or permissions is as
        // much a violation as one that changed their bytes.
        const intact = await Promise.all([walkTree(skillDirectory), walkTree(inputDirectory)]).then(
          ([skillNow, inputNow]) =>
            treeDigest(skillNow) === skillDigest &&
            treeDigest(inputNow) === input.source.inputDigest,
          () => false,
        );
        if (!intact) throw runError("isolation_violated", { runRef });
      });

      const result = yield* guard(async () =>
        decodeResult((await resultStatus(outDirectory)).toString("utf8")),
      ).pipe(
        Effect.mapError((error) =>
          error.category === "isolation_violated"
            ? error
            : runError("executor_failed", { runRef, cause: error }),
        ),
      );

      // Cross-check the executor's claimed reads against the manifest the
      // runner computed itself. An unverifiable claim is unknown telemetry.
      const manifest = new Map(input.skill.map((entry) => [entry.path, entry.sha256]));
      const verified = result.skillReads.filter((read) => manifest.get(read.path) === read.sha256);
      const unverifiable = result.skillReads.length - verified.length;
      const allowed = new Set(input.source.spec.allowedSkillLoads);
      const { mustContain, mustNotContain } = input.source.spec.expect;
      const passed =
        mustContain.every((needle) => result.answer.includes(needle)) &&
        !mustNotContain.some((needle) => result.answer.includes(needle));

      return {
        runRef,
        contextId,
        fixtureId: input.source.spec.fixtureId,
        fixtureHash: input.source.fixtureHash,
        configDigest: input.executor.configDigest,
        observedSkillSha256: skillDigest,
        outcome: passed ? "pass" : "fail",
        skillTriggered: verified.length > 0,
        unnecessaryLoads: verified.filter((read) => !allowed.has(read.path)).length,
        repeatedLookups: verified.length - new Set(verified.map((read) => read.path)).size,
        completionQuality:
          unverifiable > 0
            ? "unknown"
            : result.completed && result.answer.length > 0
              ? "ok"
              : "degraded",
      } satisfies Observation;
    });

    const replay = Effect.fn("MissionRetroReplayRunner.replay")(function* (
      raw: MissionRetroReplayRequest,
    ): Effect.fn.Return<MissionRetroReplayReceipt, MissionRetroReplayRunError> {
      const request = yield* Effect.try({
        try: () => decodeRequest(structuredClone(raw)),
        catch: (cause) => runError("invalid_request", { cause }),
      });
      // The author never grades their own candidate: refused before anything runs.
      if (request.authorId === config.reviewerId) return yield* runError("not_independent");

      const guard = <A>(thunk: () => Promise<A>) =>
        Effect.tryPromise({
          try: thunk,
          catch: (cause) =>
            isRunError(cause)
              ? cause
              : (cause as NodeJS.ErrnoException)?.code === "ENOENT"
                ? runError("unsafe_input", { cause })
                : runError("persistence", { cause }),
        });
      const executor = yield* guard(prepareExecutor).pipe(
        Effect.mapError((error) =>
          error.category === "persistence"
            ? runError("executor_unavailable", { cause: error })
            : error,
        ),
      );
      const sandboxRoot = yield* guard(() => resolveSandboxRoot(config.sandboxRoot));

      const old = yield* guard(() => walkTree(request.snapshots.old));
      const next = yield* guard(() => walkTree(request.snapshots.new));
      const sources = yield* guard(() =>
        Promise.all(FIXTURE_CLASSES.map((c) => loadSource(c, request.fixtures[c]))),
      );
      const leaked = yield* guard(async () => {
        for (const source of sources) if (await leaks(source, executor)) return true;
        return false;
      });
      const owned = request.targetOwnership === "owned";

      const replayId = NodeCrypto.randomUUID().slice(0, 12);
      const pairs: Array<{
        readonly fixtureClass: FixtureClass;
        readonly old: Observation;
        readonly new: Observation;
      }> = [];

      // Leaked or non-owned evidence is not worth an executor run: the
      // validator decides both before it reads a single pair.
      if (owned && !leaked) {
        yield* Effect.acquireUseRelease(
          guard(() => NodeFSP.mkdtemp(NodePath.join(sandboxRoot, "replay-"))),
          (replayDirectory) =>
            Effect.gen(function* () {
              let sequence = 0;
              for (const source of sources) {
                for (let sample = 0; sample < config.repeatCount; sample += 1) {
                  const run = (side: "old" | "new") => {
                    sequence += 1;
                    return executeRun({
                      executor,
                      replayDirectory,
                      replayId,
                      sequence,
                      fixtureClass: source.fixtureClass,
                      side,
                      sample,
                      skillSource: side === "old" ? request.snapshots.old : request.snapshots.new,
                      skill: side === "old" ? old : next,
                      source,
                    });
                  };
                  const oldObservation = yield* run("old");
                  const newObservation = yield* run("new");
                  pairs.push({
                    fixtureClass: source.fixtureClass,
                    old: oldObservation,
                    new: newObservation,
                  });
                }
              }
            }),
          (replayDirectory) => Effect.promise(() => removeTree(replayDirectory)),
        );
      }

      const kind = executor.config.kind;
      const envelope: SkillReplayEvidenceEnvelope = {
        schemaVersion: 1,
        binding: {
          teamId: request.scope.teamId,
          environmentId: request.scope.environmentId,
          missionId: request.scope.originMissionId,
          retroEpoch: request.retroEpoch,
          sourceReportHash: request.scope.sourceReportHash,
          normalizedReportHash: request.scope.normalizedReportHash,
          candidateId: request.scope.candidateId,
          evaluationId: request.evaluationId,
          targetSkillRef: request.scope.targetSkillRef,
          oldSkillSha256: treeDigest(old),
          newSkillSha256: treeDigest(next),
        },
        candidate: request.candidateClaim,
        replay: {
          proofClass: kind,
          route: executor.config.route ?? null,
          authorId: request.authorId,
          reviewerId: config.reviewerId,
          ownership:
            request.targetOwnership === "owned" ? "owned-isolated" : request.targetOwnership,
          configDigest: executor.configDigest,
          runMode: kind === "model_backed" ? "stochastic" : "deterministic",
          requiredRepeatCount: config.repeatCount,
          telemetryComplete:
            owned &&
            !leaked &&
            pairs.every(
              (pair) =>
                pair.old.completionQuality !== "unknown" &&
                pair.new.completionQuality !== "unknown",
            ),
          leakageCheck: leaked ? "fail" : "pass",
          pairs,
        },
      };
      const committed = yield* commitSkillReplayEvidence({
        artifactDirectory: config.artifactDirectory,
        envelope,
      }).pipe(Effect.mapError((cause) => runError("persistence", { cause })));
      return { ...committed, envelope, runCount: pairs.length * 2 };
    });

    const configDigest = Effect.tryPromise({
      try: () => prepareExecutor().then((executor) => executor.configDigest),
      catch: (cause) => (isRunError(cause) ? cause : runError("executor_unavailable", { cause })),
    });

    return MissionRetroReplayRunner.of({ replay, configDigest });
  });

/**
 * Runner layer. `config` is root-owned and immutable: it fixes the executor
 * (kind, absolute executable, static args and env, optional pinned files,
 * subscription route), the independent reviewer identity, the private
 * sandbox root, the evidence root and the repeat count. Needs only a
 * `ChildProcessSpawner` (for example `NodeServices.layer`). Invalid config
 * fails the layer with `invalid_config` instead of running anything.
 */
export const layer = (config: MissionRetroReplayRunnerConfig) =>
  Layer.effect(
    MissionRetroReplayRunner,
    Effect.suspend(() => {
      const decoded = (() => {
        try {
          return decodeConfig(structuredClone(config));
        } catch (cause) {
          return runError("invalid_config", { cause });
        }
      })();
      return isRunError(decoded) ? Effect.fail(decoded) : make(decoded);
    }),
  );
