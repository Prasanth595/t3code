// @effect-diagnostics nodeBuiltinImport:off -- real temp directories, real spawned test executor, independent digests.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import {
  reconcileSkillEvaluation,
  type SkillEvaluationTrustedContext,
} from "./MissionRetroSkillEvaluation.ts";
import {
  readSkillReplayEvidence,
  type SkillReplayEvidenceEnvelope,
} from "./MissionRetroReplayArtifacts.ts";
import * as Runner from "./MissionRetroReplayRunner.ts";

/**
 * Acceptance for the replay runner. Everything runs for real: private temp
 * directories, a real spawned test executable (`node` running a script kept
 * OUTSIDE every snapshot, fixture and sandbox), real process groups, and the
 * unchanged pure validator reading the runner's evidence.
 *
 * What this proves, and what it does not: the executor is a deterministic
 * script. These tests prove the replay pipeline (isolation, independent
 * hashing, grading, telemetry cross-checks, bounds, cleanup, config and role
 * gates). They say nothing about a real model's behavior; no model, network,
 * or API key is involved, and the "model_backed" test only exercises the
 * config and evidence plumbing with the same script.
 */

const sha = (value: Uint8Array | string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const OLD_SKILL = "# Skill\nNORMAL-FLOW\n";
const NEW_SKILL = "# Skill\nNORMAL-FLOW\nFIX-APPLIED\n";
const EXTRA = "extra reference\n";

// The deterministic test executor. It only ever sees its own env, copies and cwd.
const EXECUTOR = String.raw`
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const skillDir = process.env.NOFUN_REPLAY_SKILL_DIR;
const inputDir = process.env.NOFUN_REPLAY_INPUT_DIR;
const outDir = process.env.NOFUN_REPLAY_OUT_DIR;
const task = JSON.parse(fs.readFileSync(path.join(inputDir, "task.json"), "utf8"));
const skillBytes = fs.readFileSync(path.join(skillDir, "SKILL.md"));
const skill = skillBytes.toString("utf8");
if (process.env.DRIFT_PINNED_FILE) fs.appendFileSync(process.env.DRIFT_PINNED_FILE, "\n// executor drift\n");

if (task.diagPath) {
  fs.appendFileSync(task.diagPath, JSON.stringify({
    runRef: process.env.NOFUN_REPLAY_RUN_REF,
    env: Object.keys(process.env).sort(),
    cwd: process.cwd(),
    skillDir, inputDir, outDir,
    siblings: fs.readdirSync(path.dirname(inputDir)).sort(),
    skillLocked: (fs.statSync(path.join(skillDir, "SKILL.md")).mode & 0o222) === 0,
  }) + "\n");
}

const grandchild = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.unref();
  return child.pid;
};
const record = (extra) => {
  const info = JSON.stringify({ pid: process.pid, ...extra });
  if (task.pidFile) fs.writeFileSync(task.pidFile, info);
  if (task.fifo) fs.writeFileSync(task.fifo, info);
};

if (skill.includes("CRASH")) process.exit(3);
if (task.mode === "hang") { record({}); setInterval(() => {}, 1000); }
else if (task.mode === "grandchild-hang") { record({ grandchild: grandchild() }); setInterval(() => {}, 1000); }
else if (task.mode === "grandchild-crash") { record({ grandchild: grandchild() }); process.exit(3); }
else if (task.mode === "flood") { process.stdout.write("x".repeat(64 * 1024)); process.exit(0); }
else {
  if (task.mode === "grandchild-exit") record({ grandchild: grandchild() });
  const sabotage = skill.includes("SABOTAGE");
  let answer;
  if (sabotage) answer = "result: sabotaged";
  else if (task.kind === "failure") answer = skill.includes("FIX-APPLIED") ? "result: fixed-behavior-ok" : "result: broken-behavior";
  else if (task.kind === "positive") answer = skill.includes("NORMAL-FLOW") ? "result: normal-flow-ok" : "result: broken-behavior";
  else answer = "result: no-skill-needed-ok";
  const read = (rel, bytes) => ({ path: rel, sha256: skill.includes("BADREAD") ? "0".repeat(64) : sha(bytes) });
  const skillReads = [];
  if (task.useSkill) {
    for (let i = 0; i < (task.repeatReads ?? 1); i += 1) skillReads.push(read("SKILL.md", skillBytes));
    if (task.extraRead) skillReads.push(read("references/extra.md", fs.readFileSync(path.join(skillDir, "references", "extra.md"))));
  }
  if (skill.includes("MUTATE-SKILL")) {
    fs.chmodSync(skillDir, 0o700);
    fs.chmodSync(path.join(skillDir, "SKILL.md"), 0o600);
    fs.appendFileSync(path.join(skillDir, "SKILL.md"), "tampered");
  }
  if (skill.includes("LOCKOUT")) fs.chmodSync(skillDir, 0o000);
  if (task.mode === "mutate-input") {
    fs.chmodSync(inputDir, 0o700);
    fs.chmodSync(path.join(inputDir, "task.json"), 0o600);
    fs.appendFileSync(path.join(inputDir, "task.json"), " ");
  }
  const body = JSON.stringify({ completed: !skill.includes("DEGRADED"), answer, skillReads });
  if (task.mode === "garbage-result") fs.writeFileSync(path.join(outDir, "result.json"), "not json");
  else if (task.mode === "oversize-result") fs.writeFileSync(path.join(outDir, "result.json"), "x".repeat(70 * 1024));
  else if (task.mode === "symlink-result") {
    const elsewhere = path.join(path.dirname(outDir), "work", "elsewhere.json");
    fs.writeFileSync(elsewhere, body);
    fs.symlinkSync(elsewhere, path.join(outDir, "result.json"));
  } else fs.writeFileSync(path.join(outDir, "result.json"), body);
}
`;

type FixtureClass = "failure" | "positive" | "negative";
const EXPECT: Record<FixtureClass, string> = {
  failure: "fixed-behavior-ok",
  positive: "normal-flow-ok",
  negative: "no-skill-needed-ok",
};

interface World {
  readonly root: string;
  readonly script: string;
  readonly snapshots: { readonly old: string; readonly new: string };
  readonly fixtures: Record<FixtureClass, string>;
  readonly sandboxRoot: string;
  readonly artifacts: string;
  readonly diag: string;
}

const writeSnapshot = async (directory: string, skill: string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.join(directory, "references"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(directory, "SKILL.md"), skill);
  await NodeFSP.writeFile(NodePath.join(directory, "references", "extra.md"), EXTRA);
};

const writeFixture = async (
  directory: string,
  fixtureClass: FixtureClass,
  task: Record<string, unknown>,
  overrides: { readonly leak?: boolean } = {},
): Promise<void> => {
  await NodeFSP.mkdir(NodePath.join(directory, "input"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, "spec.json"),
    JSON.stringify({
      fixtureId: `fixture:${fixtureClass}`,
      expect: { mustContain: [EXPECT[fixtureClass]], mustNotContain: ["sabotaged"] },
      allowedSkillLoads: ["SKILL.md"],
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "input", "task.json"),
    JSON.stringify({
      kind: fixtureClass,
      useSkill: fixtureClass !== "negative",
      ...task,
      ...(overrides.leak === true ? { note: `the answer is ${EXPECT[fixtureClass]}` } : {}),
    }),
  );
};

interface WorldOptions {
  readonly tasks?: Partial<Record<FixtureClass, Record<string, unknown>>>;
  readonly oldSkill?: string;
  readonly newSkill?: string;
  readonly leak?: FixtureClass;
}

const makeWorld = (options: WorldOptions = {}) =>
  Effect.acquireRelease(
    Effect.promise(async (): Promise<World> => {
      const root = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "replay-runner-")),
      );
      const diag = NodePath.join(root, "diag.jsonl");
      const script = NodePath.join(root, "tools", "executor.mjs");
      await NodeFSP.mkdir(NodePath.dirname(script));
      await NodeFSP.writeFile(script, EXECUTOR);
      const snapshots = {
        old: NodePath.join(root, "snap-old"),
        new: NodePath.join(root, "snap-new"),
      };
      await writeSnapshot(snapshots.old, options.oldSkill ?? OLD_SKILL);
      await writeSnapshot(snapshots.new, options.newSkill ?? NEW_SKILL);
      const fixtures = {
        failure: NodePath.join(root, "fx-failure"),
        positive: NodePath.join(root, "fx-positive"),
        negative: NodePath.join(root, "fx-negative"),
      };
      for (const fixtureClass of ["failure", "positive", "negative"] as const) {
        await writeFixture(
          fixtures[fixtureClass],
          fixtureClass,
          { diagPath: diag, ...options.tasks?.[fixtureClass] },
          { leak: options.leak === fixtureClass },
        );
      }
      return {
        root,
        script,
        snapshots,
        fixtures,
        sandboxRoot: NodePath.join(root, "sandboxes"),
        artifacts: NodePath.join(root, "artifacts"),
        diag,
      };
    }),
    (world) => Effect.promise(() => NodeFSP.rm(world.root, { recursive: true, force: true })),
  );

const configFor = (
  world: World,
  over: {
    readonly executor?: Partial<Runner.MissionRetroReplayRunnerConfig["executor"]>;
    readonly reviewerId?: string;
    readonly repeatCount?: number;
  } = {},
): Runner.MissionRetroReplayRunnerConfig => ({
  executor: {
    kind: "deterministic_executable",
    executable: process.execPath,
    args: [world.script],
    pinnedFiles: [world.script],
    timeoutMs: 20_000,
    ...over.executor,
  },
  reviewerId: over.reviewerId ?? "reviewer:replay-harness",
  sandboxRoot: world.sandboxRoot,
  artifactDirectory: world.artifacts,
  repeatCount: over.repeatCount ?? 1,
});

const SOURCE_REPORT = "a".repeat(64);
const NORMALIZED_REPORT = "b".repeat(64);
const TARGET = "skills/retro-reporter/SKILL.md";

const requestFor = (
  world: World,
  over: Partial<Runner.MissionRetroReplayRequest> = {},
): Runner.MissionRetroReplayRequest => ({
  scope: {
    teamId: "team",
    environmentId: "env",
    originMissionId: "mission",
    candidateId: "candidate:one",
    targetSkillRef: TARGET,
    sourceReportHash: SOURCE_REPORT,
    normalizedReportHash: NORMALIZED_REPORT,
  },
  evaluationId: "evaluation:one",
  retroEpoch: 4,
  authorId: "author:writer-1",
  targetOwnership: "owned",
  candidateClaim: {
    candidateId: "candidate:one",
    targetSkillRef: TARGET,
    sourceReportHash: SOURCE_REPORT,
    claimedPass: true,
  },
  snapshots: world.snapshots,
  fixtures: world.fixtures,
  ...over,
});

const replayWith = (
  config: Runner.MissionRetroReplayRunnerConfig,
  request: Runner.MissionRetroReplayRequest,
) =>
  Effect.gen(function* () {
    const runner = yield* Runner.MissionRetroReplayRunner;
    return yield* runner.replay(request);
  }).pipe(Effect.provide(Runner.layer(config).pipe(Layer.provide(NodeServices.layer))));

/** The unchanged pure validator, over the context the envelope describes. */
const validate = (
  envelope: SkillReplayEvidenceEnvelope,
  request: Runner.MissionRetroReplayRequest,
) => {
  const context: SkillEvaluationTrustedContext = {
    scope: request.scope,
    authorId: envelope.replay.authorId,
    reviewerId: envelope.replay.reviewerId,
    oldSnapshotDigest: envelope.binding.oldSkillSha256,
    newSnapshotDigest: envelope.binding.newSkillSha256,
    ownership: envelope.replay.ownership,
    configDigest: envelope.replay.configDigest,
    runMode: envelope.replay.runMode,
    requiredRepeatCount: envelope.replay.requiredRepeatCount,
    telemetryComplete: envelope.replay.telemetryComplete,
    leakageCheck: envelope.replay.leakageCheck,
    pairs: envelope.replay.pairs,
  };
  const decided = reconcileSkillEvaluation({ context, candidate: envelope.candidate });
  assert.isTrue(Result.isSuccess(decided), "validator must decode the runner's evidence");
  if (!Result.isSuccess(decided)) throw new Error("unreachable");
  return decided.success;
};

/** Independent re-implementation of the snapshot digest, kept in the test on purpose. */
const digestOfFiles = (files: Record<string, string>): string =>
  sha(
    stableStringify(
      Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, text]) => ({ path, sha256: sha(text), size: Buffer.byteLength(text) })),
    ),
  );

const failureOf = <A>(effect: Effect.Effect<A, Runner.MissionRetroReplayRunError>) =>
  Effect.flip(effect);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await NodeFSP.readFile(path, "utf8")) as Record<string, unknown>;

const treeSnapshot = async (directory: string): Promise<string> => {
  const out: Array<string> = [];
  const visit = async (dir: string): Promise<void> => {
    for (const name of (await NodeFSP.readdir(dir)).sort()) {
      const full = NodePath.join(dir, name);
      const status = await NodeFSP.lstat(full);
      if (status.isDirectory()) await visit(full);
      else
        out.push(
          `${NodePath.relative(directory, full)}:${sha(await NodeFSP.readFile(full))}:${status.mode & 0o777}`,
        );
    }
  };
  await visit(directory);
  return out.join("\n");
};

const exists = (path: string): Promise<boolean> =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

it.live(
  "replays three fixture classes in isolation and the unchanged validator reads review_ready",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld({
          tasks: { positive: { extraRead: true, repeatReads: 2 } },
        });
        const request = requestFor(world);
        const before = {
          old: yield* Effect.promise(() => treeSnapshot(world.snapshots.old)),
          new: yield* Effect.promise(() => treeSnapshot(world.snapshots.new)),
          failure: yield* Effect.promise(() => treeSnapshot(world.fixtures.failure)),
        };
        const receipt = yield* replayWith(configFor(world), request);
        const { envelope } = receipt;

        // Deterministic executable proof, not a model effect.
        assert.strictEqual(envelope.replay.proofClass, "deterministic_executable");
        assert.isNull(envelope.replay.route);
        assert.strictEqual(envelope.replay.runMode, "deterministic");
        assert.strictEqual(receipt.runCount, 6);
        assert.deepStrictEqual(
          envelope.replay.pairs.map((pair) => pair.fixtureClass),
          ["failure", "positive", "negative"],
        );

        // Digests the runner observed equal digests the test computes itself.
        const oldDigest = digestOfFiles({ "SKILL.md": OLD_SKILL, "references/extra.md": EXTRA });
        const newDigest = digestOfFiles({ "SKILL.md": NEW_SKILL, "references/extra.md": EXTRA });
        assert.strictEqual(envelope.binding.oldSkillSha256, oldDigest);
        assert.strictEqual(envelope.binding.newSkillSha256, newDigest);
        for (const pair of envelope.replay.pairs) {
          assert.strictEqual(pair.old.observedSkillSha256, oldDigest);
          assert.strictEqual(pair.new.observedSkillSha256, newDigest);
          assert.strictEqual(pair.old.fixtureHash, pair.new.fixtureHash);
          assert.strictEqual(pair.old.configDigest, envelope.replay.configDigest);
        }
        const runRefs = envelope.replay.pairs.flatMap((pair) => [pair.old.runRef, pair.new.runRef]);
        const contexts = envelope.replay.pairs.flatMap((pair) => [
          pair.old.contextId,
          pair.new.contextId,
        ]);
        assert.strictEqual(new Set(runRefs).size, 6);
        assert.strictEqual(new Set(contexts).size, 6);

        // Baseline fails, the fix passes; positive and negative stay clean.
        const [failure, positive, negative] = envelope.replay.pairs;
        assert.deepStrictEqual([failure?.old.outcome, failure?.new.outcome], ["fail", "pass"]);
        assert.deepStrictEqual([positive?.old.outcome, positive?.new.outcome], ["pass", "pass"]);
        assert.deepStrictEqual([negative?.old.outcome, negative?.new.outcome], ["pass", "pass"]);
        assert.isTrue(positive?.new.skillTriggered);
        assert.isFalse(negative?.new.skillTriggered);
        // Counters come from verified reads against the runner's own manifest.
        assert.strictEqual(positive?.new.unnecessaryLoads, 1);
        assert.strictEqual(positive?.new.repeatedLookups, 1);
        assert.strictEqual(negative?.new.unnecessaryLoads, 0);
        assert.isTrue(envelope.replay.telemetryComplete);
        assert.strictEqual(envelope.replay.leakageCheck, "pass");

        const decision = validate(envelope, request);
        assert.strictEqual(decision.kind, "review_ready");
        assert.strictEqual(decision.reason, "ready_fix_verified");

        // Nothing the runner was pointed at was written; the sandbox is gone.
        assert.strictEqual(
          yield* Effect.promise(() => treeSnapshot(world.snapshots.old)),
          before.old,
        );
        assert.strictEqual(
          yield* Effect.promise(() => treeSnapshot(world.snapshots.new)),
          before.new,
        );
        assert.strictEqual(
          yield* Effect.promise(() => treeSnapshot(world.fixtures.failure)),
          before.failure,
        );
        assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(world.sandboxRoot)), []);

        // The committed artifact rereads to exactly this envelope at its own address.
        const reread = yield* readSkillReplayEvidence({
          artifactDirectory: world.artifacts,
          artifactRef: receipt.artifactRef,
        });
        assert.strictEqual(reread.artifactSha, receipt.artifactSha);
        assert.deepStrictEqual(reread.envelope, envelope);
      }),
    ),
);

it.live("hands the executor only isolated read-only copies and a scrubbed environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const secret = "sk-ant-test-sentinel-0123456789abcdef";
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.ANTHROPIC_API_KEY = secret;
          process.env.OPENAI_API_KEY = secret;
        }),
        () =>
          Effect.sync(() => {
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.OPENAI_API_KEY;
          }),
      );
      yield* replayWith(
        configFor(world, { executor: { env: { PATH: "/usr/bin:/bin" } } }),
        requestFor(world),
      );
      const runs = (yield* Effect.promise(() => NodeFSP.readFile(world.diag, "utf8")))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              env: Array<string>;
              cwd: string;
              skillDir: string;
              inputDir: string;
              siblings: Array<string>;
              skillLocked: boolean;
            },
        );
      assert.strictEqual(runs.length, 6);
      for (const run of runs) {
        // Exactly the runner's variables plus the root-configured one: no inherited credentials.
        assert.deepStrictEqual(
          run.env.filter((name) => name !== "__CF_USER_TEXT_ENCODING"),
          [
            "HOME",
            "NOFUN_REPLAY_INPUT_DIR",
            "NOFUN_REPLAY_OUT_DIR",
            "NOFUN_REPLAY_RUN_REF",
            "NOFUN_REPLAY_SKILL_DIR",
            "PATH",
            "TMPDIR",
          ],
        );
        // The runner-private spec (expected answers) is not in the executor's sandbox.
        assert.deepStrictEqual(run.siblings, ["input", "out", "skill", "work"]);
        assert.isTrue(run.skillLocked);
        for (const visible of [run.skillDir, run.inputDir, run.cwd]) {
          assert.isTrue(
            visible.startsWith(world.sandboxRoot),
            "executor paths live in the sandbox",
          );
          assert.notInclude(visible, "snap-");
          assert.notInclude(visible, "fx-");
        }
      }
    }),
  ),
);

it.live(
  "ignores a forged pass claim and a retargeted candidate: observations are the runner's own",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The new snapshot actively breaks every fixture while the author claims a pass.
        const world = yield* makeWorld({ newSkill: `${NEW_SKILL}SABOTAGE\n` });
        const request = requestFor(world);
        const forged = yield* replayWith(configFor(world), request);
        assert.isTrue(forged.envelope.candidate.claimedPass);
        assert.isTrue(forged.envelope.replay.pairs.every((pair) => pair.new.outcome === "fail"));
        const decision = validate(forged.envelope, request);
        assert.strictEqual(decision.reason, "rejected_forged_receipt");

        const retargeted = requestFor(world, {
          candidateClaim: {
            ...request.candidateClaim,
            targetSkillRef: "skills/other-owner/SKILL.md",
          },
        });
        const second = yield* replayWith(configFor(world), retargeted);
        assert.strictEqual(validate(second.envelope, request).reason, "rejected_retarget");
      }),
    ),
);

it.live("keeps every other config, digest, and role mismatch finite", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const request = requestFor(world);
      const base = yield* replayWith(configFor(world), request);

      // Same config, same digest. A changed pinned script, argument or env is a new identity.
      const again = yield* replayWith(configFor(world), request);
      assert.strictEqual(again.envelope.replay.configDigest, base.envelope.replay.configDigest);
      const otherScript = NodePath.join(world.root, "tools", "executor-b.mjs");
      yield* Effect.promise(() => NodeFSP.writeFile(otherScript, `${EXECUTOR}\n// changed\n`));
      const changedScript = yield* replayWith(
        configFor(world, { executor: { args: [otherScript], pinnedFiles: [otherScript] } }),
        request,
      );
      const changedEnv = yield* replayWith(
        configFor(world, { executor: { env: { PATH: "/usr/bin" } } }),
        request,
      );
      assert.notStrictEqual(
        changedScript.envelope.replay.configDigest,
        base.envelope.replay.configDigest,
      );
      assert.notStrictEqual(
        changedEnv.envelope.replay.configDigest,
        base.envelope.replay.configDigest,
      );
      yield* Effect.promise(() => NodeFSP.appendFile(world.script, "\n// pinned bytes changed\n"));
      const driftedPin = yield* replayWith(configFor(world), request);
      assert.notStrictEqual(
        driftedPin.envelope.replay.configDigest,
        base.envelope.replay.configDigest,
      );

      // The validator itself refuses evidence whose digests do not line up.
      const driftedPair = structuredClone(base.envelope) as SkillReplayEvidenceEnvelope;
      const edit = driftedPair.replay.pairs[0] as { new: { configDigest: string } };
      edit.new.configDigest = "e".repeat(64);
      assert.strictEqual(validate(driftedPair, request).reason, "rejected_binding_drift");
      const wrongSnapshot = structuredClone(base.envelope) as SkillReplayEvidenceEnvelope;
      (
        wrongSnapshot.replay.pairs[1] as { old: { observedSkillSha256: string } }
      ).old.observedSkillSha256 = "d".repeat(64);
      assert.strictEqual(validate(wrongSnapshot, request).reason, "rejected_snapshot_mismatch");

      // The author never grades their own work, and the executor is never started.
      yield* Effect.promise(() => NodeFSP.rm(world.diag, { force: true }));
      const self = yield* failureOf(
        replayWith(configFor(world, { reviewerId: "author:writer-1" }), request),
      );
      assert.strictEqual(self.category, "not_independent");
      assert.isFalse(yield* Effect.promise(() => exists(world.diag)));
    }),
  ),
);

it.live("refuses invalid config instead of running anything", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const build = (config: Runner.MissionRetroReplayRunnerConfig) =>
        Layer.build(Runner.layer(config).pipe(Layer.provide(NodeServices.layer))).pipe(
          Effect.scoped,
          Effect.flip,
        );
      const good = configFor(world);
      const route = {
        providerInstanceId: "muse-personal",
        model: "muse-spark-1.3-contributor",
        billing: "subscription" as const,
      };
      const bad: Array<Runner.MissionRetroReplayRunnerConfig> = [
        // Relative executable.
        configFor(world, { executor: { executable: "node" } }),
        // Credential-like or reserved environment.
        configFor(world, { executor: { env: { ANTHROPIC_API_KEY: "x" } } }),
        configFor(world, { executor: { env: { SERVICE_TOKEN: "x" } } }),
        configFor(world, { executor: { env: { NOFUN_REPLAY_SKILL_DIR: "/etc" } } }),
        configFor(world, { executor: { env: { PATH: "sk-ant-0123456789abcdef0123" } } }),
        configFor(world, { executor: { args: ["--token=ghp_0123456789abcdefghij0123"] } }),
        // A deterministic executable has no route; a model-backed one needs a subscription route and 2+ samples.
        configFor(world, { executor: { route } }),
        configFor(world, { executor: { kind: "model_backed" }, repeatCount: 2 }),
        configFor(world, { executor: { kind: "model_backed", route }, repeatCount: 1 }),
        // Out-of-range limits and repeat count.
        configFor(world, { executor: { timeoutMs: 0 } }),
        configFor(world, { repeatCount: 0 }),
        configFor(world, { repeatCount: 9 }),
        // Excess properties are rejected, never stripped.
        { ...good, extra: true } as unknown as Runner.MissionRetroReplayRunnerConfig,
        {
          ...good,
          executor: { ...good.executor, billing: "api" },
        } as unknown as Runner.MissionRetroReplayRunnerConfig,
      ];
      for (const config of bad) {
        assert.strictEqual((yield* build(config)).category, "invalid_config");
      }
      const apiRoute = { ...route, billing: "api" } as unknown as typeof route;
      const api = configFor(world, {
        executor: { kind: "model_backed", route: apiRoute },
        repeatCount: 2,
      });
      assert.strictEqual((yield* build(api)).category, "invalid_config");
      assert.isFalse(yield* Effect.promise(() => exists(world.sandboxRoot)));
    }),
  ),
);

it.live("rejects unsafe snapshots and fixtures before spawning", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeWorld();
      yield* Effect.promise(() => NodeFSP.rm(world.diag, { force: true }));
      const request = requestFor(world);
      const category = (r: Runner.MissionRetroReplayRequest) =>
        failureOf(replayWith(configFor(world), r)).pipe(Effect.map((error) => error.category));

      // A symlink inside a snapshot.
      yield* Effect.promise(() =>
        NodeFSP.symlink("/etc/hosts", NodePath.join(world.snapshots.new, "link.md")),
      );
      assert.strictEqual(yield* category(request), "unsafe_input");
      yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(world.snapshots.new, "link.md")));

      // A snapshot that is itself a symlink to a real directory.
      const alias = NodePath.join(world.root, "snap-alias");
      yield* Effect.promise(() => NodeFSP.symlink(world.snapshots.new, alias));
      assert.strictEqual(
        yield* category({ ...request, snapshots: { old: world.snapshots.old, new: alias } }),
        "unsafe_input",
      );

      // An unsafe file name and an over-bound tree.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(world.snapshots.new, "bad;name"), "x"),
      );
      assert.strictEqual(yield* category(request), "unsafe_input");
      yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(world.snapshots.new, "bad;name")));
      yield* Effect.promise(async () => {
        for (let i = 0; i < 260; i += 1) {
          await NodeFSP.writeFile(NodePath.join(world.snapshots.new, `f${i}.md`), "x");
        }
      });
      assert.strictEqual(yield* category(request), "unsafe_input");

      // A fixture without its runner-private spec.
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(world.fixtures.failure, "spec.json")));
      assert.strictEqual(
        yield* category({
          ...request,
          snapshots: { old: world.snapshots.old, new: world.snapshots.old },
        }),
        "unsafe_input",
      );

      // A spec that does not decode (here: no expected strings) is unsafe input, not a run.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(world.fixtures.failure, "spec.json"),
          '{"fixtureId":"fixture:failure","expect":{"mustContain":[],"mustNotContain":[]},"allowedSkillLoads":[]}',
        ),
      );
      assert.strictEqual(
        yield* category({
          ...request,
          snapshots: { old: world.snapshots.old, new: world.snapshots.old },
        }),
        "unsafe_input",
      );

      // Excess request properties are rejected, never stripped.
      const excess = {
        ...request,
        executable: "/bin/sh",
      } as unknown as Runner.MissionRetroReplayRequest;
      assert.strictEqual(yield* category(excess), "invalid_request");
      assert.isFalse(yield* Effect.promise(() => exists(world.diag)));
    }),
  ),
);

it.live(
  "does not run an executor for leaked or non-owned evidence and the validator still decides",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leaking = yield* makeWorld({ leak: "positive" });
        const request = requestFor(leaking);
        const leaked = yield* replayWith(configFor(leaking), request);
        assert.strictEqual(leaked.envelope.replay.leakageCheck, "fail");
        assert.deepStrictEqual(leaked.envelope.replay.pairs, []);
        assert.strictEqual(leaked.runCount, 0);
        assert.isFalse(yield* Effect.promise(() => exists(leaking.diag)));
        assert.strictEqual(validate(leaked.envelope, request).reason, "rejected_leakage");

        const clean = yield* makeWorld();
        const upstream = requestFor(clean, { targetOwnership: "upstream" });
        const held = yield* replayWith(configFor(clean), upstream);
        assert.strictEqual(held.envelope.replay.ownership, "upstream");
        assert.deepStrictEqual(held.envelope.replay.pairs, []);
        assert.isFalse(yield* Effect.promise(() => exists(clean.diag)));
        assert.strictEqual(validate(held.envelope, upstream).reason, "hold_upstream_ownership");
      }),
    ),
);

it.live("rejects executor configuration drift during a replay before committing evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const config = configFor(world, { executor: { env: { DRIFT_PINNED_FILE: world.script } } });
      const failure = yield* failureOf(replayWith(config, requestFor(world)));
      assert.strictEqual(failure.category, "isolation_violated");
      assert.isFalse(yield* Effect.promise(() => exists(world.artifacts)));
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(world.sandboxRoot)), []);
    }),
  ),
);

it.live("keeps unverifiable or degraded telemetry unknown so the validator holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The new skill makes the executor claim a read whose hash the runner cannot match.
      const unverifiable = yield* makeWorld({ newSkill: `${NEW_SKILL}BADREAD\n` });
      const request = requestFor(unverifiable);
      const receipt = yield* replayWith(configFor(unverifiable), request);
      const [, positive] = receipt.envelope.replay.pairs;
      assert.strictEqual(positive?.new.completionQuality, "unknown");
      assert.isFalse(positive?.new.skillTriggered, "an unverified read is not a trigger");
      assert.isFalse(receipt.envelope.replay.telemetryComplete);
      assert.strictEqual(validate(receipt.envelope, request).reason, "hold_unknown_telemetry");

      const degraded = yield* makeWorld({ newSkill: `${NEW_SKILL}DEGRADED\n` });
      const second = yield* replayWith(configFor(degraded), requestFor(degraded));
      assert.strictEqual(second.envelope.replay.pairs[0]?.new.completionQuality, "degraded");
    }),
  ),
);

it.live("treats identical snapshots as no change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeWorld({ oldSkill: NEW_SKILL });
      const request = requestFor(world);
      const receipt = yield* replayWith(configFor(world), request);
      assert.strictEqual(
        receipt.envelope.binding.oldSkillSha256,
        receipt.envelope.binding.newSkillSha256,
      );
      assert.strictEqual(validate(receipt.envelope, request).kind, "no_change");
    }),
  ),
);

it.live(
  "runs a stochastic model-backed config with its repeat count (config plumbing only, no model)",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const request = requestFor(world);
        const route = {
          providerInstanceId: "muse-personal",
          model: "muse-spark-1.3-contributor",
          billing: "subscription" as const,
        };
        // The same deterministic script stands in for a model harness here.
        const receipt = yield* replayWith(
          configFor(world, { executor: { kind: "model_backed", route }, repeatCount: 2 }),
          request,
        );
        const { replay } = receipt.envelope;
        assert.strictEqual(replay.proofClass, "model_backed");
        assert.deepStrictEqual(replay.route, route);
        assert.strictEqual(replay.runMode, "stochastic");
        assert.strictEqual(replay.requiredRepeatCount, 2);
        assert.strictEqual(replay.pairs.length, 6);
        assert.strictEqual(receipt.runCount, 12);
        assert.strictEqual(validate(receipt.envelope, request).kind, "review_ready");
      }),
    ),
);

it.live(
  "fails a run closed on timeout, output flood, bad results and a mutated snapshot or input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const category = (
          options: WorldOptions,
          executor: Partial<Runner.MissionRetroReplayRunnerConfig["executor"]> = {},
        ) =>
          Effect.gen(function* () {
            const world = yield* makeWorld(options);
            const error = yield* failureOf(
              replayWith(configFor(world, { executor }), requestFor(world)),
            );
            // A failed run leaves no evidence and no sandbox behind.
            assert.isFalse(yield* Effect.promise(() => exists(world.artifacts)));
            assert.deepStrictEqual(
              yield* Effect.promise(() => NodeFSP.readdir(world.sandboxRoot)),
              [],
            );
            return error.category;
          });

        assert.strictEqual(yield* category({ newSkill: `${NEW_SKILL}CRASH\n` }), "executor_failed");
        assert.strictEqual(
          yield* category({ tasks: { failure: { mode: "flood" } } }, { maxOutputBytes: 1024 }),
          "output_exceeded",
        );
        assert.strictEqual(
          yield* category({ tasks: { failure: { mode: "garbage-result" } } }),
          "executor_failed",
        );
        assert.strictEqual(
          yield* category({ tasks: { failure: { mode: "oversize-result" } } }),
          "executor_failed",
        );
        assert.strictEqual(
          yield* category({ tasks: { failure: { mode: "symlink-result" } } }),
          "executor_failed",
        );
        // The executor rewrites its own read-only copy: a mutated snapshot or fixture is never an observation.
        assert.strictEqual(
          yield* category({ newSkill: `${NEW_SKILL}MUTATE-SKILL\n` }),
          "isolation_violated",
        );
        assert.strictEqual(
          yield* category({ tasks: { failure: { mode: "mutate-input" } } }),
          "isolation_violated",
        );
        // Breaking a copy's permissions is a violation too, and the sandbox is still removed.
        assert.strictEqual(
          yield* category({ newSkill: `${NEW_SKILL}LOCKOUT\n` }),
          "isolation_violated",
        );
      }),
    ),
);

it.live("kills the whole process group on timeout and removes the sandbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pidFile = NodePath.join(NodeOS.tmpdir(), `replay-pids-${NodeCrypto.randomUUID()}.json`);
      const world = yield* makeWorld({ tasks: { failure: { mode: "grandchild-hang", pidFile } } });
      yield* Effect.addFinalizer(() => Effect.promise(() => NodeFSP.rm(pidFile, { force: true })));
      const error = yield* failureOf(
        replayWith(
          configFor(world, { executor: { timeoutMs: 4_000, forceKillAfterMs: 500 } }),
          requestFor(world),
        ),
      );
      assert.strictEqual(error.category, "executor_timeout");
      const { pid, grandchild } = (yield* Effect.promise(() => readJson(pidFile))) as {
        pid: number;
        grandchild: number;
      };
      assert.isFalse(alive(pid), "the executor must be dead");
      assert.isFalse(alive(grandchild), "its descendant must be dead too");
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(world.sandboxRoot)), []);
      assert.isFalse(yield* Effect.promise(() => exists(world.artifacts)));
    }),
  ),
);

it.live("kills a descendant after a failed exit and after a clean one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pidFile = NodePath.join(NodeOS.tmpdir(), `replay-pids-${NodeCrypto.randomUUID()}.json`);
      yield* Effect.addFinalizer(() => Effect.promise(() => NodeFSP.rm(pidFile, { force: true })));

      const crashing = yield* makeWorld({
        tasks: { failure: { mode: "grandchild-crash", pidFile } },
      });
      const crashed = yield* failureOf(replayWith(configFor(crashing), requestFor(crashing)));
      assert.strictEqual(crashed.category, "executor_failed");
      const failedPids = (yield* Effect.promise(() => readJson(pidFile))) as {
        pid: number;
        grandchild: number;
      };
      assert.isFalse(alive(failedPids.pid));
      assert.isFalse(alive(failedPids.grandchild), "a failed child's descendants must not leak");

      const lingering = yield* makeWorld({
        tasks: { failure: { mode: "grandchild-exit", pidFile } },
      });
      const completed = yield* replayWith(configFor(lingering), requestFor(lingering));
      assert.strictEqual(completed.runCount, 6);
      const cleanPids = (yield* Effect.promise(() => readJson(pidFile))) as {
        pid: number;
        grandchild: number;
      };
      assert.isFalse(
        alive(cleanPids.grandchild),
        "a descendant left behind by a clean exit must be reaped",
      );
    }),
  ),
);

it.live("cancels a running replay, kills its process group, and removes the sandbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fifo = NodePath.join(NodeOS.tmpdir(), `replay-fifo-${NodeCrypto.randomUUID()}`);
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      yield* Effect.addFinalizer(() => Effect.promise(() => NodeFSP.rm(fifo, { force: true })));
      const world = yield* makeWorld({ tasks: { failure: { mode: "grandchild-hang", fifo } } });
      const fiber = yield* Effect.forkChild(replayWith(configFor(world), requestFor(world)));
      // Rendezvous: the executor writes this only once it is running with a descendant.
      const started = (yield* Effect.promise(() => readJson(fifo))) as {
        pid: number;
        grandchild: number;
      };
      assert.isTrue(alive(started.pid));
      assert.isTrue(alive(started.grandchild));
      yield* Fiber.interrupt(fiber);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.isFalse(alive(started.pid), "interruption must kill the executor");
      assert.isFalse(alive(started.grandchild), "interruption must kill its descendants");
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(world.sandboxRoot)), []);
      assert.isFalse(yield* Effect.promise(() => exists(world.artifacts)));
    }),
  ),
);
