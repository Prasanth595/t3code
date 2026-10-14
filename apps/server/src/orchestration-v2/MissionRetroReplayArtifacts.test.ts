// @effect-diagnostics nodeBuiltinImport:off -- real temp directories, real spawned test executor, independent digests.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, Mission, MissionId, TeamId, ThreadId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { Mission as MissionValue } from "../../../../packages/contracts/src/mission.ts";
import type { MissionRetroSourceRef as SourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";
import * as Analysis from "./MissionRetroAnalysisStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as Artifacts from "./MissionRetroReplayArtifacts.ts";
import * as Runner from "./MissionRetroReplayRunner.ts";
import { commitArtifactBytes } from "./MissionRetroReportArtifacts.ts";
import {
  computeRetroReportHash,
  withActualReportHash,
  type MissionRetroReportTrustedCoverage,
} from "./MissionRetroReportReconciliation.ts";
import * as ReportStore from "./MissionRetroReportStore.ts";
import * as SkillStore from "./MissionRetroSkillEvaluationStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

/**
 * Acceptance for the immutable replay-evidence artifacts and the producer
 * that links them to the accepted recorder.
 *
 * Part one drives the filesystem adapter directly: content addressing, exact
 * canonical bytes, tamper, wrong-address, symlink and path-escape, clobber
 * and bound handling, all on real temp directories.
 *
 * Part two is end to end through real parts only: genuine MissionService,
 * event store, command receipts and SQLite projection, the report staged
 * through the genuine checkpoint, analysis and report stores (the normalized
 * report is written to disk by the real report artifact commit), a real
 * spawned deterministic test executor under the real runner, and the real
 * producer and recorder. The private authority and the stop/pause intent are
 * the only fixtures. The executor is a deterministic script, so a recorded
 * review_ready here proves the pipeline and the recorder link, not a model
 * effect.
 */

const sha = (value: Uint8Array | string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const exists = (path: string): Promise<boolean> =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

const tempDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(async () =>
      NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    ),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

// ---------------------------------------------------------------------------
// Part one: the filesystem adapter
// ---------------------------------------------------------------------------

const observation = (side: "old" | "new", index: number) => ({
  runRef: `run:${side}:${index}`,
  contextId: `ctx:${side}:${index}`,
  fixtureId: "fixture:one",
  fixtureHash: "1".repeat(64),
  configDigest: "c".repeat(64),
  observedSkillSha256: side === "old" ? "a".repeat(64) : "b".repeat(64),
  outcome: side === "old" ? ("fail" as const) : ("pass" as const),
  skillTriggered: false,
  unnecessaryLoads: 0,
  repeatedLookups: 0,
  completionQuality: "ok" as const,
});

const envelopeFixture = (
  over: Partial<Artifacts.SkillReplayEvidenceEnvelope> = {},
): Artifacts.SkillReplayEvidenceEnvelope => ({
  schemaVersion: 1,
  binding: {
    teamId: "team",
    environmentId: "env",
    missionId: "mission",
    retroEpoch: 4,
    sourceReportHash: "5".repeat(64),
    normalizedReportHash: "6".repeat(64),
    candidateId: "candidate:one",
    evaluationId: "evaluation:one",
    targetSkillRef: "skills/retro-reporter/SKILL.md",
    oldSkillSha256: "a".repeat(64),
    newSkillSha256: "b".repeat(64),
  },
  candidate: {
    candidateId: "candidate:one",
    targetSkillRef: "skills/retro-reporter/SKILL.md",
    sourceReportHash: "5".repeat(64),
    claimedPass: true,
  },
  replay: {
    proofClass: "deterministic_executable",
    route: null,
    authorId: "author:writer-1",
    reviewerId: "reviewer:replay-harness",
    ownership: "owned-isolated",
    configDigest: "c".repeat(64),
    runMode: "deterministic",
    requiredRepeatCount: 1,
    telemetryComplete: true,
    leakageCheck: "pass",
    pairs: [{ fixtureClass: "failure", old: observation("old", 1), new: observation("new", 1) }],
  },
  ...over,
});

const addressDirectory = (root: string) => NodePath.join(root, "skill-replay-evidence");
const fileFor = (root: string, artifactSha: string) =>
  NodePath.join(addressDirectory(root), `${artifactSha}.json`);

const commit = (root: string, envelope: unknown) =>
  Artifacts.commitSkillReplayEvidence({ artifactDirectory: root, envelope });
const reread = (root: string, artifactRef: string) =>
  Artifacts.readSkillReplayEvidence({ artifactDirectory: root, artifactRef });

it.live("commits canonical bytes at their own SHA-256 and rereads them verbatim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = NodePath.join(yield* tempDirectory("replay-artifacts-"), "evidence");
      const envelope = envelopeFixture();
      const first = yield* commit(root, envelope);
      assert.strictEqual(first.artifactRef, `skill-replay-evidence:${first.artifactSha}`);
      assert.isFalse(first.reused);

      // The address is the digest of the exact canonical bytes on disk.
      const file = fileFor(root, first.artifactSha);
      const bytes = yield* Effect.promise(() => NodeFSP.readFile(file));
      assert.strictEqual(sha(bytes), first.artifactSha);
      assert.strictEqual(bytes.toString("utf8"), stableStringify(envelope));
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(file))).mode & 0o777, 0o400);
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(root))).mode & 0o777, 0o700);
      assert.strictEqual(
        (yield* Effect.promise(() => NodeFSP.stat(addressDirectory(root)))).mode & 0o777,
        0o700,
      );

      // Same envelope, different key order: same address, committed once, reused.
      const reordered = reverseKeys(envelope);
      const second = yield* commit(root, reordered);
      assert.strictEqual(second.artifactSha, first.artifactSha);
      assert.isTrue(second.reused);
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(addressDirectory(root))), [
        `${first.artifactSha}.json`,
      ]);

      const read = yield* reread(root, first.artifactRef);
      assert.strictEqual(read.artifactSha, first.artifactSha);
      assert.deepStrictEqual(read.envelope, envelope);

      // Racing identical commits converge on one file with no temp leftovers.
      const racing = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          commit(
            root,
            envelopeFixture({ candidate: { ...envelope.candidate, claimedPass: false } }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(new Set(racing.map((entry) => entry.artifactSha)).size, 1);
      assert.strictEqual(
        (yield* Effect.promise(() => NodeFSP.readdir(addressDirectory(root)))).length,
        2,
      );
    }),
  ),
);

it.live("rejects tampered, re-addressed, and non-canonical bytes at reread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = NodePath.join(yield* tempDirectory("replay-artifacts-"), "evidence");
      const committed = yield* commit(root, envelopeFixture());
      const file = fileFor(root, committed.artifactSha);
      const category = (ref: string) =>
        reread(root, ref).pipe(
          Effect.flip,
          Effect.map((error) => error.category),
        );

      // One flipped byte under the original address.
      const original = yield* Effect.promise(() => NodeFSP.readFile(file));
      yield* Effect.promise(async () => {
        await NodeFSP.chmod(file, 0o600);
        await NodeFSP.writeFile(
          file,
          original.toString("utf8").replace("candidate:one", "candidate:two"),
        );
        await NodeFSP.chmod(file, 0o400);
      });
      assert.strictEqual(yield* category(committed.artifactRef), "digest_mismatch");

      // A different valid envelope planted under the first address.
      const other = Buffer.from(
        stableStringify(
          envelopeFixture({
            schemaVersion: 1,
            candidate: { ...envelopeFixture().candidate, claimedPass: false },
          }),
        ),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.chmod(file, 0o600);
        await NodeFSP.writeFile(file, other);
        await NodeFSP.chmod(file, 0o400);
      });
      assert.strictEqual(yield* category(committed.artifactRef), "digest_mismatch");

      // Valid, correctly addressed JSON that is not the canonical encoding.
      const pretty = Buffer.from(prettyJson(envelopeFixture()));
      const prettySha = sha(pretty);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(fileFor(root, prettySha), pretty, { mode: 0o400 }),
      );
      assert.strictEqual(yield* category(`skill-replay-evidence:${prettySha}`), "invalid_envelope");

      // Right address, malformed envelope.
      const garbage = Buffer.from("{not json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(fileFor(root, sha(garbage)), garbage, { mode: 0o400 }),
      );
      assert.strictEqual(
        yield* category(`skill-replay-evidence:${sha(garbage)}`),
        "invalid_envelope",
      );

      // Missing is its own category so the producer can keep it unknown.
      assert.strictEqual(yield* category(`skill-replay-evidence:${"9".repeat(64)}`), "missing");
    }),
  ),
);

it.live(
  "refuses traversal refs, symlinks, wrong permissions, relative roots and oversize files",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* tempDirectory("replay-artifacts-");
        const root = NodePath.join(base, "evidence");
        const committed = yield* commit(root, envelopeFixture());
        const file = fileFor(root, committed.artifactSha);
        const category = (artifactDirectory: string, ref: string) =>
          reread(artifactDirectory, ref).pipe(
            Effect.flip,
            Effect.map((error) => error.category),
          );

        // A ref is a strict address, never a path.
        for (const ref of [
          `skill-replay-evidence:../../${committed.artifactSha}`,
          `skill-replay-evidence:${committed.artifactSha}/..`,
          `skill-replay-evidence:${committed.artifactSha.toUpperCase()}`,
          `skill-replay-evidence:${committed.artifactSha.slice(1)}`,
          `retro-original:${committed.artifactSha}`,
          `/abs/${committed.artifactSha}`,
          "",
        ]) {
          assert.isNull(Artifacts.parseSkillReplayEvidenceRef(ref));
          assert.strictEqual(yield* category(root, ref), "invalid_ref");
        }

        // A symlink at the destination is not followed, even to identical bytes.
        const outside = NodePath.join(base, "outside.json");
        yield* Effect.promise(async () => {
          await NodeFSP.copyFile(file, outside);
          await NodeFSP.unlink(file);
          await NodeFSP.symlink(outside, file);
        });
        assert.strictEqual(yield* category(root, committed.artifactRef), "unsafe_destination");
        // Commit never writes through it either.
        const throughLink = yield* commit(root, envelopeFixture()).pipe(Effect.flip);
        assert.strictEqual(throughLink.category, "unsafe_destination");
        yield* Effect.promise(async () => {
          await NodeFSP.unlink(file);
          await NodeFSP.copyFile(outside, file);
          await NodeFSP.chmod(file, 0o400);
        });
        assert.strictEqual(
          (yield* reread(root, committed.artifactRef)).artifactSha,
          committed.artifactSha,
        );

        // A group/world readable file is not the private immutable artifact.
        yield* Effect.promise(() => NodeFSP.chmod(file, 0o644));
        assert.strictEqual(yield* category(root, committed.artifactRef), "unsafe_destination");
        yield* Effect.promise(() => NodeFSP.chmod(file, 0o400));

        // A symlinked namespace directory and a symlinked root.
        const aliasedRoot = NodePath.join(base, "aliased");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(aliasedRoot, { mode: 0o700 });
          await NodeFSP.symlink(
            addressDirectory(root),
            NodePath.join(aliasedRoot, "skill-replay-evidence"),
          );
        });
        assert.strictEqual(
          yield* category(aliasedRoot, committed.artifactRef),
          "unsafe_destination",
        );
        const rootLink = NodePath.join(base, "root-link");
        yield* Effect.promise(() => NodeFSP.symlink(root, rootLink));
        assert.strictEqual(yield* category(rootLink, committed.artifactRef), "unsafe_root");
        assert.strictEqual(
          yield* category("relative/evidence", committed.artifactRef),
          "unsafe_root",
        );
        assert.strictEqual(
          (yield* commit("relative/evidence", envelopeFixture()).pipe(Effect.flip)).category,
          "unsafe_root",
        );
        assert.strictEqual(
          yield* category(NodePath.join(base, "nowhere"), committed.artifactRef),
          "missing",
        );

        // An oversize planted file is rejected before it is hashed or decoded.
        const huge = Buffer.alloc(Artifacts.MAX_SKILL_REPLAY_EVIDENCE_BYTES + 1, 0x61);
        const hugeSha = sha(huge);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(fileFor(root, hugeSha), huge, { mode: 0o400 }),
        );
        assert.strictEqual(yield* category(root, `skill-replay-evidence:${hugeSha}`), "oversized");
      }),
    ),
);

it.live("never clobbers an accepted artifact and keeps temp files out of the namespace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = NodePath.join(yield* tempDirectory("replay-artifacts-"), "evidence");
      const envelope = envelopeFixture();
      const address = sha(stableStringify(envelope));
      // Someone planted different bytes at exactly this content address.
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(addressDirectory(root), { recursive: true, mode: 0o700 });
        await NodeFSP.writeFile(fileFor(root, address), "planted", { mode: 0o400 });
      });
      const error = yield* commit(root, envelope).pipe(Effect.flip);
      assert.strictEqual(error.category, "conflict");
      assert.strictEqual(
        yield* Effect.promise(() => NodeFSP.readFile(fileFor(root, address), "utf8")),
        "planted",
      );
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(addressDirectory(root))), [
        `${address}.json`,
      ]);
    }),
  ),
);

it.live(
  "accepts only the strict bounded envelope: no extra fields, transcripts, or inconsistent proof",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = NodePath.join(yield* tempDirectory("replay-artifacts-"), "evidence");
        const base = envelopeFixture();
        const category = (envelope: unknown) =>
          commit(root, envelope).pipe(
            Effect.flip,
            Effect.map((error) => error.category),
          );
        const withReplay = (patch: Record<string, unknown>) => ({
          ...base,
          replay: { ...base.replay, ...patch },
        });

        for (const bad of [
          // Nothing outside the schema is stored: no transcript, answer, or credential field.
          { ...base, transcript: "the model said..." },
          { ...base, replay: { ...base.replay, answer: "result: ok" } },
          { ...base, replay: { ...base.replay, apiKey: "sk-ant-0123456789abcdef0123" } },
          { ...base, binding: { ...base.binding, extra: "x" } },
          // Unsafe or oversize identity metadata.
          { ...base, binding: { ...base.binding, targetSkillRef: "../../etc/passwd" } },
          { ...base, binding: { ...base.binding, teamId: "t".repeat(300) } },
          { ...base, binding: { ...base.binding, oldSkillSha256: "A".repeat(64) } },
          // Too many pairs for the validator's bounds.
          withReplay({ pairs: Array.from({ length: 25 }, () => base.replay.pairs[0]) }),
          withReplay({ requiredRepeatCount: 9 }),
          // A proof class must match its route, run mode and sample count.
          withReplay({ proofClass: "model_backed" }),
          withReplay({
            proofClass: "model_backed",
            runMode: "stochastic",
            requiredRepeatCount: 1,
            route: { providerInstanceId: "muse-personal", model: "m", billing: "subscription" },
          }),
          withReplay({
            proofClass: "model_backed",
            runMode: "stochastic",
            requiredRepeatCount: 2,
            route: { providerInstanceId: "p", model: "m", billing: "api" },
          }),
          withReplay({ route: { providerInstanceId: "p", model: "m", billing: "subscription" } }),
          "not an envelope",
          null,
        ]) {
          assert.strictEqual(yield* category(bad), "invalid_envelope");
        }
        // Nothing was written for any rejected envelope.
        assert.isFalse(yield* Effect.promise(() => exists(root)));

        // A bounded subscription route on a stochastic model-backed proof is accepted.
        const accepted = yield* commit(
          root,
          withReplay({
            proofClass: "model_backed",
            runMode: "stochastic",
            requiredRepeatCount: 2,
            route: { providerInstanceId: "muse-personal", model: "m", billing: "subscription" },
          }),
        );
        assert.match(accepted.artifactRef, /^skill-replay-evidence:[0-9a-f]{64}$/);
      }),
    ),
);

// ---------------------------------------------------------------------------
// Part two: real replay -> immutable artifact -> real producer -> real recorder
// ---------------------------------------------------------------------------

const AUTHORITY_REF = { source: "mission-council", ref: "decision" };
const BASE_COMMIT = "a".repeat(40);
const FINGERPRINT = "a".repeat(64);
const RETRO_THREAD = "retro";
const TARGET = "skills/retro-reporter/SKILL.md";
const OLD_SKILL = "# Skill\nNORMAL-FLOW\n";
const NEW_SKILL = "# Skill\nNORMAL-FLOW\nFIX-APPLIED\n";
const REVIEWER = "reviewer:replay-harness";

const decodeFixture = Schema.decodeSync(Mission);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const missionFixture = (id: string): MissionValue =>
  decodeFixture({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team",
    authorityEnvironmentId: "env",
    bindings: [
      {
        projectId: "project",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Evaluate one skill candidate.",
      scope: ["retro"],
      exclusions: [],
      authorityRefs: [AUTHORITY_REF],
      acceptanceCriteria: [{ id: "ac", text: "Record once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root" },
    managers: {
      delivery: { threadId: "delivery", epoch: 3 },
      retro: { threadId: RETRO_THREAD, epoch: 4 },
    },
    status: "active",
    tasks: [
      {
        id: "task",
        projectId: "project",
        title: "Task",
        specHash: "spec",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac"],
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-14T00:00:00.000Z",
  });

const chunkFor = (from: number, to: number): SourceRefValue => ({
  rootRef: "thread://origin",
  chunkRef: `chunk-${from}-${to}`,
  chunkHash: "b".repeat(64),
  coveredFromInclusive: from,
  coveredToExclusive: to,
});

type Intent = { stop: boolean | null; pause: boolean | null };

interface World {
  current: boolean;
  intent: Intent;
  readonly originals: Map<string, string>;
}

// The staged report needs the per-harness originals map; carry it as a service.
class WorldTag extends Context.Service<WorldTag, World>()(
  "t3/orchestration-v2/MissionRetroReplayArtifacts.test/WorldTag",
) {}

interface Fs {
  readonly root: string;
  readonly script: string;
  readonly snapshots: { readonly old: string; readonly new: string };
  readonly fixtures: {
    readonly failure: string;
    readonly positive: string;
    readonly negative: string;
  };
  readonly sandboxRoot: string;
  readonly artifacts: string;
  readonly reportDir: string;
}

// Deterministic test executor: failure fixture needs FIX-APPLIED, positive needs NORMAL-FLOW.
const EXECUTOR = String.raw`
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const skillDir = process.env.NOFUN_REPLAY_SKILL_DIR;
const task = JSON.parse(fs.readFileSync(path.join(process.env.NOFUN_REPLAY_INPUT_DIR, "task.json"), "utf8"));
const bytes = fs.readFileSync(path.join(skillDir, "SKILL.md"));
const skill = bytes.toString("utf8");
let answer = "result: no-skill-needed-ok";
if (skill.includes("SABOTAGE")) answer = "result: sabotaged";
else if (task.kind === "failure") answer = skill.includes("FIX-APPLIED") ? "result: fixed-behavior-ok" : "result: broken-behavior";
else if (task.kind === "positive") answer = skill.includes("NORMAL-FLOW") ? "result: normal-flow-ok" : "result: broken-behavior";
const skillReads = task.useSkill ? [{ path: "SKILL.md", sha256: sha(bytes) }] : [];
fs.writeFileSync(path.join(process.env.NOFUN_REPLAY_OUT_DIR, "result.json"), JSON.stringify({ completed: true, answer, skillReads }));
`;

const EXPECT = {
  failure: "fixed-behavior-ok",
  positive: "normal-flow-ok",
  negative: "no-skill-needed-ok",
} as const;

const reverseKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : Predicate.isObject(value)
      ? Object.fromEntries(
          Object.entries(value)
            .toReversed()
            .map(([key, nested]) => [key, reverseKeys(nested)]),
        )
      : value;

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

const writeWorld = async (root: string, newSkill: string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.join(root, "tools"));
  await NodeFSP.writeFile(NodePath.join(root, "tools", "executor.mjs"), EXECUTOR);
  for (const [name, skill] of [
    ["snap-old", OLD_SKILL],
    ["snap-new", newSkill],
  ] as const) {
    await NodeFSP.mkdir(NodePath.join(root, name));
    await NodeFSP.writeFile(NodePath.join(root, name, "SKILL.md"), skill);
  }
  for (const fixtureClass of ["failure", "positive", "negative"] as const) {
    const directory = NodePath.join(root, `fx-${fixtureClass}`);
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
      JSON.stringify({ kind: fixtureClass, useSkill: fixtureClass !== "negative" }),
    );
  }
};

const makeFs = (newSkill = NEW_SKILL) =>
  Effect.gen(function* () {
    const root = yield* tempDirectory("replay-e2e-");
    yield* Effect.promise(() => writeWorld(root, newSkill));
    return {
      root,
      script: NodePath.join(root, "tools", "executor.mjs"),
      snapshots: { old: NodePath.join(root, "snap-old"), new: NodePath.join(root, "snap-new") },
      fixtures: {
        failure: NodePath.join(root, "fx-failure"),
        positive: NodePath.join(root, "fx-positive"),
        negative: NodePath.join(root, "fx-negative"),
      },
      sandboxRoot: NodePath.join(root, "sandboxes"),
      artifacts: NodePath.join(root, "artifacts"),
      reportDir: NodePath.join(root, "reports"),
    } satisfies Fs;
  });

const runnerConfig = (
  fs: Fs,
  over: { readonly reviewerId?: string; readonly args?: ReadonlyArray<string> } = {},
): Runner.MissionRetroReplayRunnerConfig => ({
  executor: {
    kind: "deterministic_executable",
    executable: process.execPath,
    args: over.args ?? [fs.script],
    pinnedFiles: [fs.script],
    timeoutMs: 30_000,
  },
  reviewerId: over.reviewerId ?? REVIEWER,
  sandboxRoot: fs.sandboxRoot,
  artifactDirectory: fs.artifacts,
  repeatCount: 1,
});

const withRunner = <A, E>(
  config: Runner.MissionRetroReplayRunnerConfig,
  use: (runner: Runner.MissionRetroReplayRunner["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* Runner.MissionRetroReplayRunner);
  }).pipe(Effect.provide(Runner.layer(config).pipe(Layer.provide(NodeServices.layer))));

/** The root pins the digest of the executor config it approved. */
const approvedDigest = (config: Runner.MissionRetroReplayRunnerConfig) =>
  withRunner(config, (runner) => runner.configDigest);

const harness = (input: { readonly fs: Fs; readonly digests: ReadonlyArray<string> }) => {
  const world: World = {
    current: true,
    intent: { stop: false, pause: false },
    originals: new Map(),
  };
  const delivery = {
    teamId: TeamId.make("team"),
    environmentId: EnvironmentId.make("env"),
    controllerThreadId: ThreadId.make("delivery"),
  };
  const retro = { ...delivery, controllerThreadId: ThreadId.make(RETRO_THREAD) };

  const snapshot = Layer.succeed(Checkpoints.MissionRetroSnapshotPort, {
    readSnapshot: (cmd: Checkpoints.MissionRetroCaptureCommand) =>
      Effect.gen(function* () {
        return {
          teamId: "team",
          environmentId: "env",
          deliveryThreadId: "delivery",
          deliveryEpoch: 3,
          nowMs: yield* Clock.currentTimeMillis,
          missionId: cmd.missionId,
          sourceRoot: "thread://origin",
          sourceThreadId: "origin",
          actualOrigin: "product",
          eligibleTrigger: "milestone",
          fromInclusive: cmd.fromInclusive,
          toExclusive: cmd.toExclusive,
          snapshotFingerprint: FINGERPRINT,
          sourceRefs: [],
          omissions: [],
          coverage: "unknown" as const,
          pendingChildRuns: false,
          capacity: {
            state: "unknown" as const,
            accountId: null,
            company: null,
            reporterIdentity: null,
            exhausted: false,
            lowReserve: false,
            profile: null,
          },
        };
      }),
  });
  const analysisPort = Layer.succeed(Analysis.MissionRetroAnalysisFactsPort, {
    readClaimFacts: (
      cmd: Analysis.MissionRetroAnalysisClaimCommand,
      cp: Analysis.MissionRetroAnalysisCheckpoint,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          teamId: "team",
          environmentId: "env",
          missionId: cmd.missionId,
          checkpointId: cp.checkpointId,
          retroThreadId: RETRO_THREAD,
          retroEpoch: 4,
          sourceThreadId: cp.sourceThreadId,
          sourceRoot: cp.sourceRoot,
          snapshotFingerprint: cp.snapshotFingerprint,
          coveredFromInclusive: cp.coveredFromInclusive,
          coveredToExclusive: cp.coveredToExclusive,
          nowMs,
          maxFactAgeMs: 60_000,
          leaseDurationMs: 100000,
          capacity: {
            ready: true,
            exhausted: false,
            lowReserve: false,
            verified: true,
            company: "No Fun",
            accountId: "account",
            providerInstanceId: "muse-personal" as const,
            modelId: "muse-spark-1.3-contributor",
            profile: "muse-review",
            observedAtMs: nowMs,
            accountRef: "account-ref",
            providerRef: "provider-ref",
            capacityRef: "capacity-ref",
          },
          host: {
            hostId: "host",
            bootId: "boot",
            verified: true,
            interactivePressureVerified: true,
            pressureReady: true,
            buildVerified: true,
            productiveWorkPriority: true,
            observedAtMs: nowMs,
            hostRef: "host-ref",
            buildRef: "build-ref",
            priorityRef: "priority-ref",
          },
          prepared: {
            reporterChildThreadId: `child-${cmd.missionId}-${cp.checkpointId}`,
            reporterRunId: `run-${cmd.missionId}-${cp.checkpointId}`,
            verified: true,
            receiptRef: "prepared-ref",
          },
        };
      }),
    readTerminalFacts: (cmd: Analysis.MissionRetroAnalysisSettleCommand) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          teamId: "team",
          environmentId: "env",
          missionId: cmd.missionId,
          checkpointId: cmd.checkpointId,
          retroThreadId: RETRO_THREAD,
          retroEpoch: 4,
          nowMs,
          maxFactAgeMs: 60_000,
          binding: {
            assignmentToken: cmd.assignmentToken,
            fence: cmd.fence,
            attemptNumber: cmd.attemptNumber,
            reporterChildThreadId: cmd.reporterChildThreadId,
            reporterRunId: cmd.reporterRunId,
            hostId: cmd.hostId,
            bootId: cmd.bootId,
          },
          verified: true,
          status: "succeeded" as const,
          receiptRef: "terminal-ref",
          observedAtMs: nowMs,
        };
      }),
  });
  // The original report stays in memory (the report store's own concern); the
  // NORMALIZED report is committed to disk by the real report artifact commit,
  // which is what the producer rereads to confirm the shortlist.
  const reportPort = Layer.succeed(ReportStore.MissionRetroReportArtifactPort, {
    readOriginal: (readInput: ReportStore.MissionRetroReportReadInput) =>
      Effect.gen(function* () {
        const bytes = world.originals.get(readInput.command.originalArtifactRef);
        if (bytes === undefined)
          return yield* new ReportStore.MissionRetroReportStoreError({
            operation: "receive",
            category: "persistence",
          });
        const report = decodeJson(bytes) as ReportValue;
        const chunk = chunkFor(report.coveredFromInclusive, report.coveredToExclusive);
        const coverage: MissionRetroReportTrustedCoverage = {
          manifestSourceRefs: [chunk],
          readReceipts: [chunk],
          apiCoverage: "full",
          childLogCoverage: "full",
          rawStdoutCoverage: "full",
          pendingChildRuns: false,
          trustedSkillLoads: [],
        };
        return {
          teamId: "team",
          environmentId: "env",
          missionId: readInput.command.missionId,
          checkpointId: readInput.command.checkpointId,
          retroThreadId: RETRO_THREAD,
          retroEpoch: 4,
          sourceThreadId: "origin",
          sourceRoot: "thread://origin",
          snapshotFingerprint: FINGERPRINT,
          coveredFromInclusive: report.coveredFromInclusive,
          coveredToExclusive: report.coveredToExclusive,
          originalArtifactRef: readInput.command.originalArtifactRef,
          descriptorBytes: bytes,
          report,
          actualOrigin: "product",
          coverage,
        };
      }),
    prepareNormalized: (prepareInput: ReportStore.MissionRetroReportPrepareInput) =>
      Effect.gen(function* () {
        const bytes = stableStringify(prepareInput.report);
        const evidenceBytes = stableStringify(prepareInput.coverageEvidence);
        const evidenceSha = sha(evidenceBytes);
        yield* commitArtifactBytes({
          artifactDirectory: input.fs.reportDir,
          namespace: "retro-normalized",
          sha: prepareInput.report.reportHash,
          bytes: Buffer.from(bytes, "utf8"),
        });
        return {
          artifactRef: `retro-normalized:${prepareInput.report.reportHash}`,
          coverageEvidence: {
            artifactRef: `retro-coverage:${evidenceSha}`,
            artifactSha: evidenceSha,
            descriptorBytes: evidenceBytes,
          },
          artifactSha: sha(bytes),
          descriptorBytes: bytes,
        };
      }),
  });

  const authority = Layer.succeed(SkillStore.MissionRetroSkillEvaluationAuthority, {
    teamId: "team",
    environmentId: "env",
    retroThreadId: RETRO_THREAD,
    retroEpoch: 4,
    isCurrent: () => world.current,
  });
  // One MissionService instance (delivery authority) serves the harness and the
  // producer: layers are memoized by identity, so the constant must not be built twice.
  const missions = MissionService.layer.pipe(
    Layer.provide(Events.layer),
    Layer.provide(Receipts.layer),
    Layer.provide(Layer.succeed(MissionService.MissionAuthority, delivery)),
  );
  const producer = Artifacts.layerReplayEvidenceProducer({
    artifactDirectory: input.fs.artifacts,
    reportArtifactDirectory: input.fs.reportDir,
    reviewerId: REVIEWER,
    approvedConfigDigests: input.digests,
    isCurrent: () => world.current,
    readUserIntent: Effect.sync(() => ({ ...world.intent })),
  }).pipe(Layer.provide(missions));

  const base = Layer.mergeAll(
    SkillStore.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
      Layer.provide(producer),
    ),
    ReportStore.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, retro)),
      Layer.provide(reportPort),
    ),
    Analysis.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, retro)),
      Layer.provide(analysisPort),
    ),
    Checkpoints.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, delivery)),
      Layer.provide(snapshot),
    ),
    missions,
    // The producer the store consumes, exposed so fences can be probed directly.
    producer,
    Events.layer,
    Receipts.layer,
  );
  return { world, layer: base.pipe(Layer.provideMerge(Sqlite.layerMemory)) };
};
type Harness = ReturnType<typeof harness>;

const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "expected success result");
  if (Result.isSuccess(result)) return result.success;
  throw new Error("unreachable");
};

const current = (id: string) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* MissionService.MissionService).get(MissionId.make(id)));
  });

const staged = (id: string, tag: string) =>
  Effect.gen(function* () {
    const svc = yield* MissionService.MissionService;
    yield* svc.execute({
      type: "mission.create",
      commandId: CommandId.make(`create-${id}`),
      mission: missionFixture(id),
    });
    return yield* stageReport(id, tag);
  });

/** Capture, claim, receive and settle one genuine candidate-bearing report. */
const stageReport = (id: string, tag: string) =>
  Effect.gen(function* () {
    const h = yield* Effect.service(WorldTag);
    const checkpoints = yield* Checkpoints.MissionRetroCheckpointStore;
    const analyses = yield* Analysis.MissionRetroAnalysisStore;
    const reports = yield* ReportStore.MissionRetroReportStore;
    const captured = ok(
      yield* checkpoints.capture({
        commandId: CommandId.make(`capture-${tag}`),
        missionId: id,
        expectedRevision: (yield* current(id)).revision,
        deliveryEpoch: 3,
        sourceThreadId: "origin",
        fromInclusive: 1,
        toExclusive: 2,
        trigger: "milestone",
      }),
    );
    const checkpointId = captured.checkpoint.checkpointId;
    const claimed = ok(
      yield* analyses.claim({
        commandId: CommandId.make(`claim-${tag}`),
        missionId: id,
        checkpointId,
        expectedRevision: (yield* current(id)).revision,
        retroEpoch: 4,
      }),
    );
    const lease = claimed.analysis.lease;
    assert.isNotNull(lease, "claim must produce a lease");
    if (lease === null) throw new Error("unreachable");
    const report: ReportValue = withActualReportHash({
      checkpointId,
      teamId: "team",
      environmentId: "env",
      missionId: id,
      sourceThreadId: "origin",
      sourceRoot: "thread://origin",
      snapshotFingerprint: FINGERPRINT,
      coveredFromInclusive: 1,
      coveredToExclusive: 2,
      reporterChildThreadId: lease.reporterChildThreadId,
      reporterRunId: lease.reporterRunId,
      reportRevision: lease.reportRevision,
      assignmentToken: lease.assignmentToken,
      managerEpoch: 4,
      model: "muse-spark-1.3-contributor",
      profile: "muse-review",
      sourceRefs: [chunkFor(1, 2)],
      claimedReadRefs: [],
      summary: "summary",
      verdict: "candidates",
      shortlist: [
        {
          candidateId: `candidate:${tag}`,
          concernId: `concern:${tag}`,
          incidentRefs: [`incident:${tag}`],
          summary: "c",
          destinationOwner: "project_guidance",
          alreadyFixed: false,
        },
      ],
      incidents: [
        {
          incidentId: `incident:${tag}`,
          concernId: `concern:${tag}`,
          sourceEventRef: `event:${tag}`,
          summary: "s",
          destinationOwner: "project_guidance",
        },
      ],
      skillEvidence: [],
      omissions: [],
    });
    const bytes = stableStringify(report);
    h.originals.set(`retro-original:${tag}`, bytes);
    const out = ok(
      yield* reports.receive({
        commandId: CommandId.make(`receive-${tag}`),
        missionId: id,
        checkpointId,
        expectedRevision: (yield* current(id)).revision,
        retroEpoch: 4,
        originalArtifactRef: `retro-original:${tag}`,
        originalArtifactSha: sha(bytes),
        claimedSourceReportHash: computeRetroReportHash(report),
      }),
    );
    ok(
      yield* analyses.settle({
        commandId: CommandId.make(`settle-${tag}`),
        missionId: id,
        checkpointId,
        expectedRevision: (yield* current(id)).revision,
        retroEpoch: 4,
        assignmentToken: lease.assignmentToken,
        fence: claimed.analysis.fence,
        attemptNumber: claimed.analysis.attemptNumber,
        reporterChildThreadId: lease.reporterChildThreadId,
        reporterRunId: lease.reporterRunId,
        hostId: lease.hostId,
        bootId: lease.bootId,
      }),
    );
    assert.strictEqual(out.disposition, "queued_for_triage");
    return {
      candidateId: `candidate:${tag}`,
      sourceReportHash: out.sourceReportHash,
      normalizedReportHash: out.normalizedReportHash,
    };
  });

const run = <A, E, R>(h: Harness, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(h.layer), Effect.provideService(WorldTag, h.world));

type Staged = Effect.Success<ReturnType<typeof staged>>;

const requestFor = (
  fs: Fs,
  report: Staged,
  over: Partial<Runner.MissionRetroReplayRequest> = {},
): Runner.MissionRetroReplayRequest => ({
  scope: {
    teamId: "team",
    environmentId: "env",
    originMissionId: "mission",
    candidateId: report.candidateId,
    targetSkillRef: TARGET,
    sourceReportHash: report.sourceReportHash,
    normalizedReportHash: report.normalizedReportHash,
  },
  evaluationId: "evaluation:one",
  retroEpoch: 4,
  authorId: "author:writer-1",
  targetOwnership: "owned",
  candidateClaim: {
    candidateId: report.candidateId,
    targetSkillRef: TARGET,
    sourceReportHash: report.sourceReportHash,
    claimedPass: true,
  },
  snapshots: fs.snapshots,
  fixtures: fs.fixtures,
  ...over,
});

type Classified =
  | { readonly kind: "ok"; readonly outcome: SkillStore.MissionRetroSkillEvaluationOutcome }
  | { readonly kind: "hold"; readonly code: string }
  | { readonly kind: "error"; readonly category: string };

const isHold = Schema.is(SkillStore.MissionRetroSkillEvaluationHold);

const record = (
  report: Staged,
  receipt: { readonly artifactRef: string; readonly artifactSha: string },
  over: Partial<SkillStore.MissionRetroSkillEvaluationRecordCommand> = {},
) =>
  Effect.gen(function* () {
    const store = yield* SkillStore.MissionRetroSkillEvaluationStore;
    const outer = yield* store
      .record({
        commandId: CommandId.make("record-1"),
        missionId: "mission",
        expectedRevision: (yield* current("mission")).revision,
        evaluationId: "evaluation:one",
        candidateId: report.candidateId,
        evidenceArtifactRef: receipt.artifactRef,
        evidenceArtifactSha: receipt.artifactSha,
        ...over,
      })
      .pipe(Effect.result);
    if (Result.isFailure(outer))
      return { kind: "error", category: outer.failure.category } as Classified;
    if (Result.isFailure(outer.success)) {
      assert.isTrue(isHold(outer.success.failure));
      return { kind: "hold", code: outer.success.failure.code } as Classified;
    }
    return { kind: "ok", outcome: outer.success.success } as Classified;
  });

const ledger = () =>
  Effect.gen(function* () {
    const mission = yield* current("mission");
    return {
      revision: mission.revision,
      records: (mission.execution?.retroSkillEvaluations ?? []).length,
    };
  });

const digestOf = (text: string): string =>
  sha(stableStringify([{ path: "SKILL.md", sha256: sha(text), size: Buffer.byteLength(text) }]));

/** A fresh world: files and a harness pinned to the approved executor config. */
const scenario = (options: { readonly newSkill?: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* makeFs(options.newSkill);
    const config = runnerConfig(fs);
    const h = harness({ fs, digests: [yield* approvedDigest(config)] });
    return { fs, config, h };
  });

it.live(
  "records a review_ready outcome from a real replay through the real producer, and replays idempotently",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, h } = yield* scenario();
        yield* run(
          h,
          Effect.gen(function* () {
            const report = yield* staged("mission", "a");
            const receipt = yield* withRunner(config, (runner) =>
              runner.replay(requestFor(fs, report)),
            );
            assert.strictEqual(receipt.envelope.replay.proofClass, "deterministic_executable");
            const file = fileFor(fs.artifacts, receipt.artifactSha);
            const artifactBytes = yield* Effect.promise(() => NodeFSP.readFile(file));

            const expectedRevision = (yield* current("mission")).revision;
            const result = yield* record(report, receipt, { expectedRevision });
            assert.strictEqual(result.kind, "ok");
            if (result.kind !== "ok") return;
            const { record: stored } = result.outcome;
            assert.isTrue(result.outcome.committed);
            assert.strictEqual(stored.kind, "review_ready");
            assert.strictEqual(stored.reason, "ready_fix_verified");
            // Digests the recorder holds are the ones computed from the snapshot bytes.
            assert.strictEqual(stored.oldSkillSha256, digestOf(OLD_SKILL));
            assert.strictEqual(stored.newSkillSha256, digestOf(NEW_SKILL));
            assert.strictEqual(stored.reviewerRef, REVIEWER);
            assert.strictEqual(stored.evidenceArtifactRef, receipt.artifactRef);
            assert.strictEqual(stored.evidenceArtifactSha, sha(artifactBytes));
            assert.strictEqual(stored.sourceReportHash, report.sourceReportHash);
            assert.strictEqual(stored.targetSkillRef, TARGET);
            assert.deepStrictEqual(stored.failurePairs, {
              required: 1,
              observed: 1,
              oldPass: 0,
              newPass: 1,
            });
            assert.deepStrictEqual(stored.negativePairs, {
              required: 1,
              observed: 1,
              oldPass: 1,
              newPass: 1,
            });
            const durable = yield* current("mission");
            assert.strictEqual(durable.execution?.retroSkillEvaluations?.length, 1);

            // The same command replays from the durable receipt: nothing new, artifact untouched.
            const before = yield* ledger();
            const again = yield* record(report, receipt, { expectedRevision });
            assert.strictEqual(again.kind, "ok");
            if (again.kind !== "ok") return;
            assert.isFalse(again.outcome.committed);
            assert.isTrue(again.outcome.recovered);
            assert.deepStrictEqual(yield* ledger(), before);
            assert.deepStrictEqual(
              yield* Effect.promise(() => NodeFSP.readFile(file)),
              artifactBytes,
            );
            // The recorder holds a pointer and digest, never a path or the evidence body.
            assert.notInclude(stableStringify(durable.execution?.retroSkillEvaluations), fs.root);
          }),
        );
      }),
    ),
);

it.live("records the validator's own rejection and never a self-asserted pass", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The new snapshot breaks every fixture while the author claims a pass.
      const { fs, config, h } = yield* scenario({ newSkill: `${NEW_SKILL}SABOTAGE\n` });
      yield* run(
        h,
        Effect.gen(function* () {
          const report = yield* staged("mission", "a");
          const receipt = yield* withRunner(config, (runner) =>
            runner.replay(requestFor(fs, report)),
          );
          assert.isTrue(receipt.envelope.candidate.claimedPass);
          const result = yield* record(report, receipt);
          assert.strictEqual(result.kind, "ok");
          if (result.kind !== "ok") return;
          assert.strictEqual(result.outcome.record.kind, "rejected");
          assert.strictEqual(result.outcome.record.reason, "rejected_forged_receipt");
        }),
      );
    }),
  ),
);

it.live("denies tampered evidence and holds on missing evidence, then records once it exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, config, h } = yield* scenario();
      yield* run(
        h,
        Effect.gen(function* () {
          const report = yield* staged("mission", "a");
          // The command points at evidence that does not exist yet: finite hold, nothing persisted.
          const planned = yield* withRunner(config, (runner) =>
            runner.replay(requestFor(fs, report)),
          );
          const file = fileFor(fs.artifacts, planned.artifactSha);
          const original = yield* Effect.promise(() => NodeFSP.readFile(file));
          yield* Effect.promise(() => NodeFSP.rm(file));
          const before = yield* ledger();
          assert.deepStrictEqual(yield* record(report, planned), {
            kind: "hold",
            code: "facts_unknown",
          });
          assert.deepStrictEqual(yield* ledger(), before);

          // One flipped byte is proof of tampering: denied, still nothing persisted.
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(file, original.toString("utf8").replace("pass", "fail"), {
              mode: 0o400,
            });
          });
          assert.deepStrictEqual(yield* record(report, planned), {
            kind: "error",
            category: "scope_denied",
          });
          assert.deepStrictEqual(yield* ledger(), before);

          // The genuine bytes return: the same command id now records.
          yield* Effect.promise(async () => {
            await NodeFSP.chmod(file, 0o600);
            await NodeFSP.writeFile(file, original);
            await NodeFSP.chmod(file, 0o400);
          });
          const recorded = yield* record(report, planned);
          assert.strictEqual(recorded.kind, "ok");
        }),
      );
    }),
  ),
);

it.live(
  "holds on unknown, stopped or paused intent and denies once the root is no longer current",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, h } = yield* scenario();
        yield* run(
          h,
          Effect.gen(function* () {
            const report = yield* staged("mission", "a");
            const receipt = yield* withRunner(config, (runner) =>
              runner.replay(requestFor(fs, report)),
            );
            const before = yield* ledger();
            const expectations: ReadonlyArray<readonly [Intent, Classified]> = [
              [
                { stop: null, pause: false },
                { kind: "hold", code: "facts_unknown" },
              ],
              [
                { stop: false, pause: null },
                { kind: "hold", code: "facts_unknown" },
              ],
              [
                { stop: true, pause: false },
                { kind: "hold", code: "user_stop" },
              ],
              [
                { stop: false, pause: true },
                { kind: "hold", code: "user_pause" },
              ],
            ];
            for (const [intent, expected] of expectations) {
              h.world.intent = intent;
              assert.deepStrictEqual(yield* record(report, receipt), expected);
            }
            h.world.intent = { stop: false, pause: false };
            h.world.current = false;
            assert.deepStrictEqual(yield* record(report, receipt), {
              kind: "error",
              category: "scope_denied",
            });
            assert.deepStrictEqual(yield* ledger(), before);
            h.world.current = true;
            assert.strictEqual((yield* record(report, receipt)).kind, "ok");
          }),
        );
      }),
    ),
);

it.live(
  "denies evidence bound to another epoch, evaluation, candidate, reviewer, or executor config",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, h } = yield* scenario();
        yield* run(
          h,
          Effect.gen(function* () {
            const report = yield* staged("mission", "a");
            const before = yield* ledger();
            const denied = (result: Classified) =>
              assert.deepStrictEqual(result, { kind: "error", category: "scope_denied" });

            // A stale Retro epoch in the evidence.
            const stale = yield* withRunner(config, (runner) =>
              runner.replay(
                requestFor(fs, report, { retroEpoch: 3, evaluationId: "evaluation:stale" }),
              ),
            );
            denied(
              yield* record(report, stale, {
                evaluationId: "evaluation:stale",
                commandId: CommandId.make("record-stale"),
              }),
            );

            // A command that names a different evaluation than the evidence is bound to.
            const bound = yield* withRunner(config, (runner) =>
              runner.replay(requestFor(fs, report)),
            );
            denied(
              yield* record(report, bound, {
                evaluationId: "evaluation:other",
                commandId: CommandId.make("record-other"),
              }),
            );

            // A candidate the canonical report never shortlisted.
            const stranger = yield* withRunner(config, (runner) =>
              runner.replay(
                requestFor(fs, report, {
                  evaluationId: "evaluation:stranger",
                  scope: {
                    ...requestFor(fs, report).scope,
                    candidateId: "candidate:not-shortlisted",
                  },
                  candidateClaim: {
                    ...requestFor(fs, report).candidateClaim,
                    candidateId: "candidate:not-shortlisted",
                  },
                }),
              ),
            );
            denied(
              yield* record(report, stranger, {
                evaluationId: "evaluation:stranger",
                candidateId: "candidate:not-shortlisted",
                commandId: CommandId.make("record-stranger"),
              }),
            );

            // A reviewer or executor config the root never approved.
            const otherReviewer = yield* withRunner(
              runnerConfig(fs, { reviewerId: "reviewer:unapproved" }),
              (runner) =>
                runner.replay(requestFor(fs, report, { evaluationId: "evaluation:reviewer" })),
            );
            denied(
              yield* record(report, otherReviewer, {
                evaluationId: "evaluation:reviewer",
                commandId: CommandId.make("record-reviewer"),
              }),
            );
            const otherScript = NodePath.join(fs.root, "tools", "executor-b.mjs");
            yield* Effect.promise(() =>
              NodeFSP.writeFile(otherScript, `${EXECUTOR}\n// another executor\n`),
            );
            const otherConfig = runnerConfig(fs, { args: [otherScript] });
            const otherExecutor = yield* withRunner(
              { ...otherConfig, executor: { ...otherConfig.executor, pinnedFiles: [otherScript] } },
              (runner) =>
                runner.replay(requestFor(fs, report, { evaluationId: "evaluation:config" })),
            );
            denied(
              yield* record(report, otherExecutor, {
                evaluationId: "evaluation:config",
                commandId: CommandId.make("record-config"),
              }),
            );

            assert.deepStrictEqual(yield* ledger(), before);
          }),
        );
      }),
    ),
);

it.live("revokes a read when the root moves on or the producer scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, config, h } = yield* scenario();
      yield* run(
        h,
        Effect.gen(function* () {
          const report = yield* staged("mission", "a");
          const receipt = yield* withRunner(config, (runner) =>
            runner.replay(requestFor(fs, report)),
          );
          const request = {
            missionId: "mission",
            evaluationId: "evaluation:one",
            candidateId: report.candidateId,
            evidenceArtifactRef: receipt.artifactRef,
            evidenceArtifactSha: receipt.artifactSha,
          };
          const producer = yield* SkillStore.MissionRetroSkillEvaluationProducer;
          const facts = yield* producer.readFacts(request);
          assert.isTrue(producer.isCurrent(facts));
          assert.isFalse(producer.isCurrent({ ...facts, fence: "replay-fence-forged" }));
          h.world.current = false;
          assert.isFalse(producer.isCurrent(facts), "the root's currency check gates every fence");
          h.world.current = true;
          assert.isTrue(producer.isCurrent(facts));

          // The read facts carry the canonical Retro role and revision, not envelope claims.
          const mission = yield* current("mission");
          assert.strictEqual(facts.retroThreadId, RETRO_THREAD);
          assert.strictEqual(facts.retroEpoch, 4);
          assert.strictEqual(facts.observedRevision, mission.revision);
          assert.strictEqual(facts.evaluation?.evidence.verification, "verified");
          assert.strictEqual(facts.evaluation?.evidence.artifactSha, receipt.artifactSha);

          // Closing the producer's scope revokes every fence it issued.
          const scope = yield* Scope.make();
          const scoped = yield* Layer.buildWithScope(
            Artifacts.layerReplayEvidenceProducer({
              artifactDirectory: fs.artifacts,
              reportArtifactDirectory: fs.reportDir,
              reviewerId: REVIEWER,
              approvedConfigDigests: ["c".repeat(64)],
              isCurrent: () => true,
            }),
            scope,
          ).pipe(
            Effect.provide(
              MissionService.layer.pipe(
                Layer.provide(Events.layer),
                Layer.provide(Receipts.layer),
                Layer.provide(
                  Layer.succeed(MissionService.MissionAuthority, {
                    teamId: TeamId.make("team"),
                    environmentId: EnvironmentId.make("env"),
                    controllerThreadId: ThreadId.make(RETRO_THREAD),
                  }),
                ),
              ),
            ),
          );
          const scopedProducer = Context.get(
            scoped,
            SkillStore.MissionRetroSkillEvaluationProducer,
          );
          const scopedFacts = yield* scopedProducer.readFacts(request);
          // Unknown stop/pause intent is never defaulted to "clear".
          assert.isNull(scopedFacts.userStopRequested);
          assert.isNull(scopedFacts.userPauseRequested);
          assert.isTrue(scopedProducer.isCurrent(scopedFacts));
          yield* Scope.close(scope, Exit.void);
          assert.isFalse(scopedProducer.isCurrent(scopedFacts));
          assert.strictEqual(
            (yield* Effect.flip(scopedProducer.readFacts(request))).category,
            "scope_denied",
          );
        }),
      );
    }),
  ),
);

it.live("refuses to build a producer from unusable options", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* tempDirectory("replay-options-");
      const good = {
        artifactDirectory: root,
        reportArtifactDirectory: root,
        reviewerId: REVIEWER,
        approvedConfigDigests: ["c".repeat(64)],
        isCurrent: () => true,
      };
      const failure = (options: Artifacts.ReplayEvidenceProducerOptions) =>
        Layer.build(Artifacts.layerReplayEvidenceProducer(options)).pipe(
          Effect.scoped,
          Effect.provideService(MissionService.MissionService, {
            get: () => Effect.succeedNone,
            execute: () => Effect.die("unused"),
          }),
          Effect.flip,
        );
      for (const bad of [
        { ...good, artifactDirectory: "relative" },
        { ...good, reportArtifactDirectory: "relative" },
        { ...good, reviewerId: " " },
        { ...good, approvedConfigDigests: [] },
        { ...good, approvedConfigDigests: ["not-a-digest"] },
      ]) {
        assert.strictEqual((yield* failure(bad)).category, "invalid_options");
      }
    }),
  ),
);
