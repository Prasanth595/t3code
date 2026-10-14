// @effect-diagnostics nodeBuiltinImport:off -- test hashes and modes bind real filesystem artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentId, Mission, MissionId, TeamId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mission as MissionValue } from "../../../../packages/contracts/src/mission.ts";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";
import type { MissionRetroSourceRef as SourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";
import * as Analysis from "./MissionRetroAnalysisStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  computeRetroReportHash,
  withActualReportHash,
  type MissionRetroReportTrustedCoverage,
} from "./MissionRetroReportReconciliation.ts";
import * as ReportStore from "./MissionRetroReportStore.ts";

const sha = (bytes: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const HASH_A = "a".repeat(64);
const FINGERPRINT = "f".repeat(64);

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const chunkFor = (from: number, to: number): SourceRefValue => ({
  rootRef: "thread://origin",
  chunkRef: `chunk-${from}-${to}`,
  chunkHash: HASH_A,
  coveredFromInclusive: from,
  coveredToExclusive: to,
});

const coverageFor = (
  from = 1,
  to = 2,
  over: Partial<MissionRetroReportTrustedCoverage> = {},
): MissionRetroReportTrustedCoverage => ({
  manifestSourceRefs: [chunkFor(from, to)],
  readReceipts: [chunkFor(from, to)],
  apiCoverage: "full",
  childLogCoverage: "full",
  rawStdoutCoverage: "full",
  pendingChildRuns: false,
  trustedSkillLoads: [],
  ...over,
});

type ReportOverrides = Partial<Omit<ReportValue, "reportHash">>;

const reportFor = (over: ReportOverrides = {}): ReportValue =>
  withActualReportHash({
    checkpointId: "checkpoint-1",
    teamId: "team",
    environmentId: "env",
    missionId: "mission-1",
    sourceThreadId: "origin",
    sourceRoot: "thread://origin",
    snapshotFingerprint: FINGERPRINT,
    coveredFromInclusive: 1,
    coveredToExclusive: 2,
    reporterChildThreadId: "child-1",
    reporterRunId: "run-1",
    reportRevision: 0,
    assignmentToken: "token-1",
    managerEpoch: 4,
    model: "muse-spark-1.3-contributor",
    profile: "muse-review",
    sourceRefs: [chunkFor(1, 2)],
    claimedReadRefs: [],
    summary: "summary",
    verdict: "no_change",
    shortlist: [],
    incidents: [],
    skillEvidence: [],
    omissions: [],
    ...over,
  });

const metadataFor = (
  over: Partial<Artifacts.MissionRetroReportTrustedMetadata> = {},
): Artifacts.MissionRetroReportTrustedMetadata => ({
  teamId: "team",
  environmentId: "env",
  missionId: "mission-1",
  checkpointId: "checkpoint-1",
  retroThreadId: "retro",
  retroEpoch: 4,
  sourceThreadId: "origin",
  sourceRoot: "thread://origin",
  snapshotFingerprint: FINGERPRINT,
  coveredFromInclusive: 1,
  coveredToExclusive: 2,
  actualOrigin: "product",
  coverage: coverageFor(),
  ...over,
});

interface ResolverDouble {
  readonly layer: Layer.Layer<Artifacts.MissionRetroReportTrustedResolver>;
  readonly calls: Array<Artifacts.MissionRetroReportResolverInput>;
}

const resolverDouble = (
  metadata: Artifacts.MissionRetroReportTrustedMetadata = metadataFor(),
): ResolverDouble => {
  const calls: Array<Artifacts.MissionRetroReportResolverInput> = [];
  const layer = Layer.succeed(Artifacts.MissionRetroReportTrustedResolver, {
    resolve: (input: Artifacts.MissionRetroReportResolverInput) =>
      Effect.sync(() => {
        calls.push(input);
        return metadata;
      }),
  });
  return { layer, calls };
};

const portIn = (dir: string, double: ResolverDouble) =>
  ReportStore.MissionRetroReportArtifactPort.pipe(
    Effect.provide(Artifacts.layerFilesystemReportArtifactPort(dir).pipe(Layer.provide(double.layer))),
  );

const commandFor = (
  staged: { readonly ref: string; readonly sha: string; readonly claimed: string },
  over: Partial<ReportStore.MissionRetroReportReceiveCommand> = {},
): ReportStore.MissionRetroReportReceiveCommand => ({
  commandId: CommandId.make("command-1"),
  missionId: "mission-1",
  checkpointId: "checkpoint-1",
  expectedRevision: 2,
  retroEpoch: 4,
  originalArtifactRef: staged.ref,
  originalArtifactSha: staged.sha,
  claimedSourceReportHash: staged.claimed,
  ...over,
});

const runNode = <A>(
  task: () => Promise<A>,
): Effect.Effect<A, ReportStore.MissionRetroReportStoreError> =>
  Effect.tryPromise({
    try: task,
    catch: (cause) =>
      new ReportStore.MissionRetroReportStoreError({
        operation: "receive",
        category: "persistence",
        cause,
      }),
  });

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const okResult = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);

const failCategory = (error: unknown): string => {
  assert.instanceOf(error, ReportStore.MissionRetroReportStoreError);
  return error.category;
};

const decodeFixture = Schema.decodeSync(Mission);
const AUTHORITY_REF = { source: "mission-council", ref: "decision" };
const BASE_COMMIT = "a".repeat(40);

const missionFixture = (id: string): MissionValue =>
  decodeFixture({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team",
    authorityEnvironmentId: "env",
    bindings: [
      { projectId: "project", workspaceRoot: "/tmp/project", baseCommit: BASE_COMMIT, ancestry: [BASE_COMMIT] },
    ],
    intent: {
      outcome: "Analyze",
      scope: ["retro"],
      exclusions: [],
      authorityRefs: [AUTHORITY_REF],
      acceptanceCriteria: [{ id: "ac", text: "Once" }],
      decisions: [],
    },
    integrationTarget: { summary: "Root" },
    managers: {
      delivery: { threadId: "delivery", epoch: 3 },
      retro: { threadId: "retro", epoch: 4 },
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

it.effect("ingest stores exact bytes under the complete-byte SHA with private modes", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-ingest-" });
      const report = reportFor();
      const bytes = stableStringify(report);
      const out = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      assert.strictEqual(out.originalArtifactSha, sha(bytes));
      assert.strictEqual(out.originalArtifactRef, `retro-original:${sha(bytes)}`);
      const path = Artifacts.artifactPathForRef(dir, out.originalArtifactRef, "retro-original");
      assert.isNotNull(path);
      assert.strictEqual(yield* runNode(() => NodeFSP.readFile(path as string, "utf8")), bytes);
      assert.strictEqual((yield* runNode(() => NodeFSP.stat(path as string))).mode & 0o777, 0o600);
      assert.strictEqual((yield* runNode(() => NodeFSP.stat(NodePath.join(dir, "retro-original")))).mode & 0o777, 0o700);
    }),
  ),
);

it.effect("ingest is idempotent across sequential and concurrent retries", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-idem-" });
      const bytes = stableStringify(reportFor());
      const first = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const second = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      assert.deepStrictEqual(second, first);
      const parallel = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes })),
        { concurrency: 8 },
      );
      for (const out of parallel) assert.deepStrictEqual(out, first);
      const path = Artifacts.artifactPathForRef(dir, first.originalArtifactRef, "retro-original");
      assert.strictEqual(yield* runNode(() => NodeFSP.readFile(path as string, "utf8")), bytes);
    }),
  ),
);

it.effect("ingest rejects oversized descriptors counting multibyte UTF-8 bytes", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-bound-" });
      const ascii = `{"pad":"${"x".repeat(524_288)}"}`;
      const asciiError = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: ascii,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(asciiError), "invalid_command");
      // 300_000 characters but 600_000 bytes: the bound is bytes, not characters.
      const multibyte = `{"pad":"${"é".repeat(300_000)}"}`;
      assert.isTrue(multibyte.length < 524_288);
      assert.isTrue(Buffer.byteLength(multibyte, "utf8") > 524_288);
      const multiError = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: multibyte,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(multiError), "invalid_command");
    }),
  ),
);

it.effect("ingest rejects non-JSON and lone-surrogate input without lossy storage", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-strict-" });
      const malformed = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: '{"truncated":',
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(malformed), "invalid_command");
      const lone = String.fromCharCode(0xd800);
      assert.strictEqual(lone.length, 1);
      const surrogateError = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: `{"pad":"${lone}","a":1}`,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(surrogateError), "invalid_command");
      assert.isFalse(yield* fs.exists(NodePath.join(dir, "retro-original")));
    }),
  ),
);

it.effect("readOriginal reopens exact bytes and keys the resolver by exact command and actual SHA", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-read-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const command = commandFor({
        ref: ingested.originalArtifactRef,
        sha: ingested.originalArtifactSha,
        claimed: computeRetroReportHash(reportFor()),
      });
      const trusted = yield* port.readOriginal({ command });
      assert.strictEqual(trusted.descriptorBytes, bytes);
      assert.strictEqual(trusted.originalArtifactRef, ingested.originalArtifactRef);
      assert.strictEqual(sha(trusted.descriptorBytes), ingested.originalArtifactSha);
      assert.deepStrictEqual(trusted.report, parseJson(bytes));
      // Resolver sees the exact current command and the actual SHA, never reporter claims.
      assert.strictEqual(double.calls.length, 1);
      assert.strictEqual(double.calls[0]?.command.commandId, "command-1");
      assert.strictEqual(double.calls[0]?.command.originalArtifactRef, ingested.originalArtifactRef);
      assert.strictEqual(double.calls[0]?.originalSha, ingested.originalArtifactSha);
      assert.strictEqual(trusted.actualOrigin, "product");
    }),
  ),
);

it.effect("readOriginal rejects wrong-typed, non-canonical, and traversal refs", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-refs-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const staged = {
        ref: ingested.originalArtifactRef,
        sha: ingested.originalArtifactSha,
        claimed: computeRetroReportHash(reportFor()),
      };
      const badRefs = [
        `retro-normalized:${ingested.originalArtifactSha}`,
        "retro-original:1",
        "retro-original:ZZZ",
        `retro-original:${ingested.originalArtifactSha.slice(0, 63)}`,
        `retro-original:${ingested.originalArtifactSha} `,
        "retro-original:../retro-normalized/abc",
        `retro-original:${ingested.originalArtifactSha}/../escape`,
      ];
      for (const ref of badRefs) {
        const error = yield* port.readOriginal({ command: commandFor(staged, { originalArtifactRef: ref }) }).pipe(
          Effect.flip,
        );
        assert.strictEqual(failCategory(error), "invalid_command", ref);
      }
      assert.strictEqual(double.calls.length, 0);
      assert.isNull(Artifacts.parseArtifactRef("retro-original:1", "retro-original"));
      assert.isNull(Artifacts.artifactPathForRef(dir, "retro-original:../escape", "retro-original"));
    }),
  ),
);

it.effect("readOriginal fails on missing files without consulting the resolver", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-missing-" });
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const phantom = `retro-original:${"0".repeat(64)}`;
      const error = yield* port.readOriginal({
        command: commandFor({ ref: phantom, sha: "0".repeat(64), claimed: "1".repeat(64) }),
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(error), "persistence");
      assert.strictEqual(double.calls.length, 0);
    }),
  ),
);

it.effect("readOriginal fails closed on corrupted bytes and invalid UTF-8 without overwriting", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-corrupt-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const path = Artifacts.artifactPathForRef(dir, ingested.originalArtifactRef, "retro-original");
      assert.isNotNull(path);
      // Corrupt in place: valid UTF-8 but wrong SHA.
      yield* runNode(() => NodeFSP.writeFile(path as string, `${bytes} `));
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const staged = {
        ref: ingested.originalArtifactRef,
        sha: ingested.originalArtifactSha,
        claimed: computeRetroReportHash(reportFor()),
      };
      const corrupt = yield* port.readOriginal({ command: commandFor(staged) }).pipe(Effect.flip);
      assert.strictEqual(failCategory(corrupt), "persistence");
      assert.strictEqual(double.calls.length, 0);
      // The corrupted file is held as-is: no repair, no phantom bytes.
      assert.strictEqual(yield* runNode(() => NodeFSP.readFile(path as string, "utf8")), `${bytes} `);
      // Invalid UTF-8 is rejected, never lossy-decoded.
      yield* runNode(() => NodeFSP.writeFile(path as string, Buffer.from([0xff, 0xfe, 0x00, 0x61])));
      const invalid = yield* Artifacts.readArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-original",
        ref: `retro-original:${sha(Buffer.from([0xff, 0xfe, 0x00, 0x61]))}`,
        maxBytes: 524_288,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(invalid), "persistence");
    }),
  ),
);

it.effect("readOriginal rejects symlink destinations and namespace escapes", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-link-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-outside-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const dest = Artifacts.artifactPathForRef(dir, ingested.originalArtifactRef, "retro-original");
      assert.isNotNull(dest);
      const genuine = path.join(outside, "genuine.json");
      yield* runNode(() => NodeFSP.writeFile(genuine, bytes));
      yield* runNode(() => NodeFSP.unlink(dest as string));
      yield* runNode(() => NodeFSP.symlink(genuine, dest as string));
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const staged = {
        ref: ingested.originalArtifactRef,
        sha: ingested.originalArtifactSha,
        claimed: computeRetroReportHash(reportFor()),
      };
      const linked = yield* port.readOriginal({ command: commandFor(staged) }).pipe(Effect.flip);
      assert.strictEqual(failCategory(linked), "persistence");
      assert.strictEqual(double.calls.length, 0);
      // A symlinked namespace directory redirects outside the root: reject it too.
      const dir2 = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-ns-" });
      yield* runNode(() => NodeFSP.symlink(
        NodePath.join(dir, "retro-original"),
        NodePath.join(dir2, "retro-original"),
      ));
      const escaped = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir2,
        descriptorBytes: bytes,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(escaped), "persistence");
    }),
  ),
);

const evidenceFor = (
  report: ReportValue,
  sourceHash: string,
  reasons: ReadonlyArray<string> = [],
): ReportStore.MissionRetroReportCoverageEvidence => ({
  checkpointId: "checkpoint-1",
  sourceReportHash: sourceHash,
  normalizedReportHash: report.reportHash,
  coverage: { full: reasons.length === 0, reasons },
  observations: coverageFor(),
});

it.effect("prepareNormalized writes the normalized descriptor and full sidecar with exact refs", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-prep-" });
      const report = reportFor();
      const sourceHash = computeRetroReportHash(report);
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const prepared = yield* port.prepareNormalized({
        report,
        coverageEvidence: evidenceFor(report, sourceHash),
        sourceReportHash: sourceHash,
        checkpointId: "checkpoint-1",
      });
      assert.strictEqual(prepared.artifactRef, `retro-normalized:${report.reportHash}`);
      assert.strictEqual(prepared.artifactSha, sha(prepared.descriptorBytes));
      // Complete-byte SHA is distinct from the report hash; the ref binds the report hash.
      assert.notStrictEqual(prepared.artifactSha, report.reportHash);
      assert.strictEqual(prepared.descriptorBytes, stableStringify(report));
      assert.strictEqual(
        prepared.coverageEvidence.artifactRef,
        `retro-coverage:${prepared.coverageEvidence.artifactSha}`,
      );
      assert.strictEqual(prepared.coverageEvidence.artifactSha, sha(prepared.coverageEvidence.descriptorBytes));
      // Reopen from disk: exact bytes, no truncation or rewrite.
      const normPath = Artifacts.artifactPathForRef(dir, prepared.artifactRef, "retro-normalized");
      const covPath = Artifacts.artifactPathForRef(dir, prepared.coverageEvidence.artifactRef, "retro-coverage");
      assert.strictEqual(yield* runNode(() => NodeFSP.readFile(normPath as string, "utf8")), prepared.descriptorBytes);
      assert.strictEqual(
        yield* runNode(() => NodeFSP.readFile(covPath as string, "utf8")),
        prepared.coverageEvidence.descriptorBytes,
      );
      assert.deepStrictEqual(
        parseJson(prepared.coverageEvidence.descriptorBytes),
        parseJson(stableStringify(evidenceFor(report, sourceHash))),
      );
      // Idempotent: preparing again reuses both files.
      const again = yield* port.prepareNormalized({
        report,
        coverageEvidence: evidenceFor(report, sourceHash),
        sourceReportHash: sourceHash,
        checkpointId: "checkpoint-1",
      });
      assert.deepStrictEqual(again, prepared);
    }),
  ),
);

it.effect("prepareNormalized keeps every coverage reason and rejects over-bound evidence", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-reasons-" });
      const report = reportFor();
      const sourceHash = computeRetroReportHash(report);
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const reasons = Array.from({ length: 24 }, (_, index) => `reason-${index}: trusted read coverage gap`);
      const prepared = yield* port.prepareNormalized({
        report,
        coverageEvidence: evidenceFor(report, sourceHash, reasons),
        sourceReportHash: sourceHash,
        checkpointId: "checkpoint-1",
      });
      const parsed = parseJson(prepared.coverageEvidence.descriptorBytes) as {
        readonly coverage: { readonly reasons: ReadonlyArray<string> };
      };
      assert.strictEqual(parsed.coverage.reasons.length, 24);
      // Over 8MB of evidence is rejected, never silently truncated.
      const huge = `x`.repeat(8 * 1024 * 1024 + 1);
      const over = yield* port.prepareNormalized({
        report,
        coverageEvidence: { ...evidenceFor(report, sourceHash), checkpointId: huge },
        sourceReportHash: sourceHash,
        checkpointId: huge,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(over), "invalid_command");
    }),
  ),
);

it.effect("prepareNormalized rejects claimed-hash and evidence-binding mismatches without writing", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-mismatch-" });
      const report = reportFor();
      const sourceHash = computeRetroReportHash(report);
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const forged = { ...report, reportHash: "0".repeat(64) };
      const forgedError = yield* port.prepareNormalized({
        report: forged,
        coverageEvidence: evidenceFor(report, sourceHash),
        sourceReportHash: sourceHash,
        checkpointId: "checkpoint-1",
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(forgedError), "invalid_command");
      const bindings = [
        { checkpointId: "checkpoint-2" },
        { sourceReportHash: "0".repeat(64) },
        {
          coverageEvidence: {
            ...evidenceFor(report, sourceHash),
            normalizedReportHash: "0".repeat(64),
          },
        },
      ] as const;
      for (const binding of bindings) {
        const error = yield* port.prepareNormalized({
          report,
          coverageEvidence: evidenceFor(report, sourceHash),
          sourceReportHash: sourceHash,
          checkpointId: "checkpoint-1",
          ...binding,
        }).pipe(Effect.flip);
        assert.strictEqual(failCategory(error), "invalid_command");
      }
      assert.isFalse(yield* fs.exists(NodePath.join(dir, "retro-normalized")));
      assert.isFalse(yield* fs.exists(NodePath.join(dir, "retro-coverage")));
    }),
  ),
);

it.effect("conflicting bytes at a content address fail closed and keep the accepted file", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-collision-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      // Plant different bytes where the accepted file lives (hash collision or corruption).
      const namespace = path.join(dir, "retro-original");
      const planted = path.join(namespace, "planted.json");
      yield* runNode(() => NodeFSP.writeFile(planted, '{"planted":true}'));
      yield* runNode(() => NodeFSP.rename(
        planted,
        path.join(namespace, `${ingested.originalArtifactSha}.json`),
      ));
      const retry = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: bytes,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(retry), "persistence");
      assert.strictEqual(
        yield* runNode(() => NodeFSP.readFile(
          path.join(namespace, `${ingested.originalArtifactSha}.json`),
          "utf8",
        )),
        '{"planted":true}',
      );
    }),
  ),
);

it.effect("filesystem faults surface as errors, never phantom receipts", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-fault-" });
      // A regular file where the artifact root must be: every commit faults.
      const blocker = NodePath.join(parent, "blocker");
      yield* runNode(() => NodeFSP.writeFile(blocker, "not a directory"));
      const fault = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: blocker,
        descriptorBytes: stableStringify(reportFor()),
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(fault), "persistence");
      const relative = yield* Artifacts.layerFilesystemReportArtifactPort("relative/path").pipe(
        Layer.provide(Artifacts.layerMissingTrustedResolver),
        Layer.build,
        Effect.flip,
      );
      assert.strictEqual(failCategory(relative), "invalid_command");
    }),
  ),
);

it.effect("wiring without a production resolver fails explicitly", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-noresolver-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const port = yield* ReportStore.MissionRetroReportArtifactPort.pipe(
        Effect.provide(
          Artifacts.layerFilesystemReportArtifactPort(dir).pipe(
            Layer.provide(Artifacts.layerMissingTrustedResolver),
          ),
        ),
      );
      const error = yield* port.readOriginal({
        command: commandFor({
          ref: ingested.originalArtifactRef,
          sha: ingested.originalArtifactSha,
          claimed: computeRetroReportHash(reportFor()),
        }),
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(error), "persistence");
    }),
  ),
);

it.effect("normalized artifact reopens by semantic ref with trusted whole-byte SHA after recreate", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-norm-reopen-" });
      const report = reportFor();
      const sourceHash = computeRetroReportHash(report);
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const prepared = yield* port.prepareNormalized({
        report,
        coverageEvidence: evidenceFor(report, sourceHash),
        sourceReportHash: sourceHash,
        checkpointId: "checkpoint-1",
      });
      // Filename is the semantic report hash, never the whole-byte SHA.
      const semanticPath = Artifacts.artifactPathForRef(dir, prepared.artifactRef, "retro-normalized");
      assert.isNotNull(semanticPath);
      assert.isTrue(yield* fs.exists(semanticPath as string));
      if (prepared.artifactSha !== report.reportHash) {
        const bytePath = NodePath.join(dir, "retro-normalized", `${prepared.artifactSha}.json`);
        assert.isFalse(yield* fs.exists(bytePath));
      }
      // Recreate the port against the same directory and reopen exactly.
      const port2 = yield* portIn(dir, double);
      void port2;
      const reopened = yield* Artifacts.readNormalizedArtifactBytes({
        artifactDirectory: dir,
        ref: prepared.artifactRef,
        expectedArtifactSha: prepared.artifactSha,
        maxBytes: 524_288,
      });
      assert.strictEqual(reopened.text, prepared.descriptorBytes);
      assert.strictEqual(reopened.artifactSha, sha(prepared.descriptorBytes));
      assert.strictEqual(reopened.reportHash, report.reportHash);
      const generic = yield* Artifacts.readArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-normalized",
        ref: prepared.artifactRef,
        maxBytes: 524_288,
      });
      assert.strictEqual(generic.sha, prepared.artifactSha);
      const wrongSha = yield* Artifacts.readNormalizedArtifactBytes({
        artifactDirectory: dir,
        ref: prepared.artifactRef,
        expectedArtifactSha: "0".repeat(64),
        maxBytes: 524_288,
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(wrongSha), "persistence");
    }),
  ),
);

it.effect("symlinked artifact root is rejected without following to its target", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-roottarget-" });
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-rootlink-" });
      const link = NodePath.join(parent, "link");
      yield* runNode(() => NodeFSP.symlink(target, link));
      const error = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: link,
        descriptorBytes: stableStringify(reportFor()),
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(error), "persistence");
      assert.isFalse(yield* fs.exists(NodePath.join(target, "retro-original")));
    }),
  ),
);

it.effect("readOriginal checks the command SHA against actual bytes before the resolver", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-wrongsha-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const double = resolverDouble();
      const port = yield* portIn(dir, double);
      const error = yield* port.readOriginal({
        command: commandFor({
          ref: ingested.originalArtifactRef,
          sha: "0".repeat(64),
          claimed: computeRetroReportHash(reportFor()),
        }),
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(error), "persistence");
      assert.strictEqual(double.calls.length, 0);
    }),
  ),
);

it.effect("readOriginal rejects resolver metadata that does not bind the exact command", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-metabind-" });
      const bytes = stableStringify(reportFor());
      const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      const double = resolverDouble(metadataFor({ missionId: "other-mission" }));
      const port = yield* portIn(dir, double);
      const error = yield* port.readOriginal({
        command: commandFor({
          ref: ingested.originalArtifactRef,
          sha: ingested.originalArtifactSha,
          claimed: computeRetroReportHash(reportFor()),
        }),
      }).pipe(Effect.flip);
      assert.strictEqual(failCategory(error), "persistence");
      assert.strictEqual(double.calls.length, 1);
    }),
  ),
);

it.effect("failed commit leaves no temp or phantom artifact and a retry succeeds", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-temp-" });
      const first = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: stableStringify(reportFor()),
      });
      void first;
      const namespace = NodePath.join(dir, "retro-original");
      const secondBytes = stableStringify(reportFor({ summary: "second" }));
      const secondSha = sha(secondBytes);
      yield* runNode(() => NodeFSP.chmod(namespace, 0o500));
      const fault = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: secondBytes,
      }).pipe(Effect.flip);
      yield* runNode(() => NodeFSP.chmod(namespace, 0o700));
      assert.strictEqual(failCategory(fault), "persistence");
      assert.isFalse(yield* fs.exists(NodePath.join(namespace, `${secondSha}.json`)));
      const entries = yield* runNode(() => NodeFSP.readdir(namespace));
      assert.deepStrictEqual(entries.filter((entry) => entry.startsWith(".tmp-")), []);
      const retry = yield* Artifacts.ingestRetroReportOriginal({
        artifactDirectory: dir,
        descriptorBytes: secondBytes,
      });
      assert.strictEqual(retry.originalArtifactSha, secondSha);
    }),
  ),
);

it.effect("low-level artifact commits reject traversal keys and namespaces before filesystem work", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-key-" });
      const input = {
        artifactDirectory: dir,
        namespace: "retro-original" as const,
        sha: sha("{}"),
        bytes: Buffer.from("{}"),
      };
      for (const bad of [
        { ...input, sha: "../outside" },
        Object.assign({ ...input }, { namespace: "../outside" }),
      ]) {
        assert.strictEqual(failCategory(yield* Artifacts.commitArtifactBytes(bad).pipe(Effect.flip)), "invalid_command");
      }
      assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(dir)), []);
    }),
  ),
);

it.effect("reuse retries an incomplete directory sync before reporting a durable artifact", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-sync-" });
      yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: "{}" });
      const namespace = NodePath.join(dir, "retro-original");
      const bytes = '{"retry":true}';
      yield* Effect.acquireRelease(
        runNode(() => NodeFSP.chmod(namespace, 0o300)),
        () => runNode(() => NodeFSP.chmod(namespace, 0o700)).pipe(Effect.orDie),
      );
      // Linking is permitted, but opening the directory for sync is denied.
      const ingest = Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
      assert.strictEqual(failCategory(yield* ingest.pipe(Effect.flip)), "persistence");
      // The matching file now exists. Reuse cannot skip the same durability gate.
      assert.strictEqual(failCategory(yield* ingest.pipe(Effect.flip)), "persistence");
      yield* runNode(() => NodeFSP.chmod(namespace, 0o700));
      assert.strictEqual((yield* ingest).originalArtifactSha, sha(bytes));
      assert.deepStrictEqual((yield* runNode(() => NodeFSP.readdir(namespace))).filter((entry) => entry.startsWith(".tmp-")), []);
    }),
  ),
);

it.effect("store.receive persists pointers through real filesystem artifacts", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-artifacts-e2e-" });
      const missionId = "artifact-mission";
      const seen: Array<Artifacts.MissionRetroReportResolverInput> = [];
      const trustedLayer = Layer.succeed(Artifacts.MissionRetroReportTrustedResolver, {
        resolve: (input: Artifacts.MissionRetroReportResolverInput) =>
          Effect.sync(() => {
            seen.push(input);
            return {
              ...metadataFor({ missionId: input.command.missionId, checkpointId: input.command.checkpointId }),
              coverage: coverageFor(1, 2),
            };
          }),
      });
      const portLayer = Artifacts.layerFilesystemReportArtifactPort(dir).pipe(Layer.provide(trustedLayer));
      const deliveryAuthority = Layer.succeed(MissionService.MissionAuthority, {
        teamId: TeamId.make("team"),
        environmentId: EnvironmentId.make("env"),
        controllerThreadId: ThreadId.make("delivery"),
      });
      const retroAuthority = Layer.succeed(MissionService.MissionAuthority, {
        teamId: TeamId.make("team"),
        environmentId: EnvironmentId.make("env"),
        controllerThreadId: ThreadId.make("retro"),
      });
      const snapshotStub = Layer.succeed(Checkpoints.MissionRetroSnapshotPort, {
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
      const analysisStub = Layer.succeed(Analysis.MissionRetroAnalysisFactsPort, {
        readClaimFacts: (cmd: Analysis.MissionRetroAnalysisClaimCommand) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            return {
              teamId: "team",
              environmentId: "env",
              missionId: cmd.missionId,
              checkpointId: cmd.checkpointId,
              retroThreadId: "retro",
              retroEpoch: 4,
              sourceThreadId: "origin",
              sourceRoot: "thread://origin",
              snapshotFingerprint: FINGERPRINT,
              coveredFromInclusive: 1,
              coveredToExclusive: 2,
              nowMs,
              maxFactAgeMs: 1000,
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
                reporterChildThreadId: `child-${cmd.missionId}`,
                reporterRunId: `run-${cmd.missionId}`,
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
              retroThreadId: "retro",
              retroEpoch: 4,
              nowMs,
              maxFactAgeMs: 1000,
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
      const stores = Layer.mergeAll(
        ReportStore.layer.pipe(
          Layer.provide(Events.layer),
          Layer.provide(Receipts.layer),
          Layer.provide(retroAuthority),
          Layer.provide(portLayer),
        ),
        Analysis.layer.pipe(
          Layer.provide(Events.layer),
          Layer.provide(Receipts.layer),
          Layer.provide(retroAuthority),
          Layer.provide(analysisStub),
        ),
        Checkpoints.layer.pipe(
          Layer.provide(Events.layer),
          Layer.provide(Receipts.layer),
          Layer.provide(deliveryAuthority),
          Layer.provide(snapshotStub),
        ),
        MissionService.layer.pipe(
          Layer.provide(Events.layer),
          Layer.provide(Receipts.layer),
          Layer.provide(deliveryAuthority),
        ),
        Events.layer,
        Receipts.layer,
      ).pipe(Layer.provideMerge(Sqlite.layerMemory));
      yield* Effect.gen(function* () {
        const missions = yield* MissionService.MissionService;
        yield* missions.execute({
          type: "mission.create",
          commandId: CommandId.make(`create-${missionId}`),
          mission: missionFixture(missionId),
        });
        const captures = yield* Checkpoints.MissionRetroCheckpointStore;
        const captured = yield* captures.capture({
          commandId: CommandId.make(`capture-${missionId}`),
          missionId,
          expectedRevision: 0,
          deliveryEpoch: 3,
          sourceThreadId: "origin",
          fromInclusive: 1,
          toExclusive: 2,
          trigger: "milestone",
        });
        assert.isTrue(Result.isSuccess(captured), "capture must succeed");
        const capturedOk = okResult(captured);
        const analyses = yield* Analysis.MissionRetroAnalysisStore;
        const claimed = yield* analyses.claim({
          commandId: CommandId.make(`claim-${missionId}`),
          missionId,
          checkpointId: capturedOk.checkpoint.checkpointId,
          expectedRevision: 1,
          retroEpoch: 4,
        });
        assert.isTrue(Result.isSuccess(claimed), "claim must succeed");
        const claimedOk = okResult(claimed);
        const lease = claimedOk.analysis.lease;
        assert.isNotNull(lease);
        if (lease === null) return yield* Effect.die("lease missing");
        const report = reportFor({
          missionId,
          checkpointId: capturedOk.checkpoint.checkpointId,
          reporterChildThreadId: lease.reporterChildThreadId,
          reporterRunId: lease.reporterRunId,
          reportRevision: lease.reportRevision,
          assignmentToken: lease.assignmentToken,
        });
        const bytes = stableStringify(report);
        const ingested = yield* Artifacts.ingestRetroReportOriginal({ artifactDirectory: dir, descriptorBytes: bytes });
        const store = yield* ReportStore.MissionRetroReportStore;
        const outcome = yield* store.receive({
          commandId: CommandId.make(`receive-${missionId}`),
          missionId,
          checkpointId: capturedOk.checkpoint.checkpointId,
          expectedRevision: 2,
          retroEpoch: 4,
          originalArtifactRef: ingested.originalArtifactRef,
          originalArtifactSha: ingested.originalArtifactSha,
          claimedSourceReportHash: computeRetroReportHash(report),
        });
        assert.isTrue(Result.isSuccess(outcome), "receive must succeed");
        const out = okResult(outcome);
        assert.isTrue(out.committed);
        assert.strictEqual(out.disposition, "queued_for_triage");
        assert.strictEqual(out.sourceReportHash, computeRetroReportHash(report));
        // No normalization change in this fixture, so the normalized hash
        // equals the source hash; the whole-byte artifact SHA is distinct.
        assert.strictEqual(out.normalizedReportHash, report.reportHash);
        // The resolver was keyed by the exact command and the actual original SHA.
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0]?.originalSha, ingested.originalArtifactSha);
        assert.strictEqual(seen[0]?.command.originalArtifactRef, ingested.originalArtifactRef);
        // The normalized artifact on disk reopens to the exact stored bytes.
        const normPath = Artifacts.artifactPathForRef(dir, out.normalizedArtifactRef, "retro-normalized");
        assert.strictEqual(yield* runNode(() => NodeFSP.readFile(normPath as string, "utf8")), stableStringify({
          ...report,
          skillEvidence: report.skillEvidence,
        }));
        // Snapshots carry pointers only: no report body text lands in the DB.
        const current = yield* missions.get(MissionId.make(missionId));
        assert.isTrue(Option.isSome(current));
        if (Option.isSome(current)) {
          assert.isFalse(stableStringify(current.value).includes('"summary":"summary"'));
          assert.strictEqual(current.value.execution?.retroReportReceipts?.length, 1);
        }
      }).pipe(Effect.provide(stores));
    }),
  ),
);

it.effect.each(["retro-source", "retro-source-chunk"] as const)(
  "%s commits and reopens exact private UTF-8 bytes",
  (namespace) =>
    scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-source-bytes-" });
        const bytes = Buffer.from('{"text":"é🧪"}', "utf8");
        const hash = sha(bytes);
        const input = { artifactDirectory: dir, namespace, sha: hash, bytes };
        // Collector chunks target 64 KiB of entries; exact serialized bytes can exceed it.
        const large = Buffer.from(stableStringify({ text: "é".repeat(40000) }));
        const largeHash = sha(large);
        yield* Artifacts.commitArtifactBytes({ artifactDirectory: dir, namespace, sha: largeHash, bytes: large });
        assert.strictEqual((yield* Artifacts.readArtifactBytes({ artifactDirectory: dir, namespace, ref: `${namespace}:${largeHash}`, maxBytes: 2097152 })).text, large.toString("utf8"));
        assert.isFalse((yield* Artifacts.commitArtifactBytes(input)).reused);
        assert.isTrue((yield* Artifacts.commitArtifactBytes(input)).reused);
        const read = yield* Artifacts.readArtifactBytes({
          artifactDirectory: dir,
          namespace,
          ref: `${namespace}:${hash}`,
          maxBytes: bytes.length,
        });
        assert.strictEqual(read.text, bytes.toString("utf8"));
        assert.strictEqual(read.sha, hash);
        assert.strictEqual(
          (yield* runNode(() => NodeFSP.stat(NodePath.join(dir, namespace, `${hash}.json`)))).mode &
            0o777,
          0o600,
        );
        assert.strictEqual(
          failCategory(
            yield* Artifacts.readArtifactBytes({
              artifactDirectory: dir,
              namespace,
              ref: `${namespace}:${hash}`,
              maxBytes: bytes.length - 1,
            }).pipe(Effect.flip),
          ),
          "persistence",
        );
        assert.strictEqual(
          failCategory(
            yield* Artifacts.commitArtifactBytes({
              ...input,
              bytes: Buffer.from("different"),
            }).pipe(Effect.flip),
          ),
          "invalid_command",
        );
        assert.strictEqual(
          (yield* Artifacts.readArtifactBytes({
            artifactDirectory: dir,
            namespace,
            ref: `${namespace}:${hash}`,
            maxBytes: 100,
          })).text,
          bytes.toString("utf8"),
        );
      }),
    ),
);

it.effect(
  "source namespaces reject malformed refs, nonprivate paths, invalid UTF-8 and oversized chunk bytes",
  () =>
    scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "source-ref-guards-" });
        const namespace = "retro-source-chunk";
        const bytes = Buffer.from("{}");
        const hash = sha(bytes);
        for (const ref of [
          `retro-source:${hash}`,
          `${namespace}:../${hash}`,
          `${namespace}:${hash.toUpperCase()}`,
          `${namespace}:${hash}/extra`,
        ]) {
          assert.isNull(Artifacts.artifactPathForRef(dir, ref, namespace));
          assert.strictEqual(
            failCategory(
              yield* Artifacts.readArtifactBytes({
                artifactDirectory: dir,
                namespace,
                ref,
                maxBytes: 100,
              }).pipe(Effect.flip),
            ),
            "invalid_command",
          );
        }
        for (const bad of [Buffer.from([0xff]), Buffer.alloc(2097153, "x")]) {
          assert.strictEqual(
            failCategory(
              yield* Artifacts.commitArtifactBytes({
                artifactDirectory: dir,
                namespace,
                sha: sha(bad),
                bytes: bad,
              }).pipe(Effect.flip),
            ),
            "invalid_command",
          );
        }
        yield* Artifacts.commitArtifactBytes({
          artifactDirectory: dir,
          namespace,
          sha: hash,
          bytes,
        });
        const dest = NodePath.join(dir, namespace, `${hash}.json`);
      const oversized = Buffer.alloc(2097153, "x");
      const oversizedHash = sha(oversized);
      yield* runNode(() => NodeFSP.writeFile(NodePath.join(dir, namespace, `${oversizedHash}.json`), oversized, { mode: 0o600 }));
      assert.strictEqual(failCategory(yield* Artifacts.readArtifactBytes({ artifactDirectory: dir, namespace, ref: `${namespace}:${oversizedHash}`, maxBytes: 1048576 }).pipe(Effect.flip)), "persistence");
      yield* runNode(() => NodeFSP.unlink(NodePath.join(dir, namespace, `${oversizedHash}.json`)));
      yield* runNode(() => NodeFSP.writeFile(dest, "tampered"));
      assert.strictEqual(failCategory(yield* Artifacts.commitArtifactBytes({ artifactDirectory: dir, namespace, sha: hash, bytes }).pipe(Effect.flip)), "persistence");
      assert.strictEqual(yield* runNode(() => NodeFSP.readFile(dest, "utf8")), "tampered");
      yield* runNode(() => NodeFSP.writeFile(dest, bytes));
      yield* runNode(() => NodeFSP.chmod(dir, 0o755));
      assert.strictEqual(failCategory(yield* Artifacts.commitArtifactBytes({ artifactDirectory: dir, namespace, sha: hash, bytes }).pipe(Effect.flip)), "persistence");
      yield* runNode(() => NodeFSP.chmod(dir, 0o700));
        yield* runNode(() => NodeFSP.chmod(dest, 0o644));
        assert.strictEqual(
          failCategory(
            yield* Artifacts.readArtifactBytes({
              artifactDirectory: dir,
              namespace,
              ref: `${namespace}:${hash}`,
              maxBytes: 100,
            }).pipe(Effect.flip),
          ),
          "persistence",
        );
        yield* runNode(() => NodeFSP.chmod(dest, 0o600));
        const genuine = NodePath.join(dir, "genuine");
        yield* runNode(() => NodeFSP.rename(dest, genuine));
        yield* runNode(() => NodeFSP.symlink(genuine, dest));
        assert.strictEqual(
          failCategory(
            yield* Artifacts.commitArtifactBytes({
              artifactDirectory: dir,
              namespace,
              sha: hash,
              bytes,
            }).pipe(Effect.flip),
          ),
          "persistence",
        );
        assert.strictEqual(
          failCategory(
            yield* Artifacts.readArtifactBytes({
              artifactDirectory: dir,
              namespace,
              ref: `${namespace}:${hash}`,
              maxBytes: 100,
            }).pipe(Effect.flip),
          ),
          "persistence",
        );
        yield* runNode(() => NodeFSP.unlink(dest));
        yield* runNode(() => NodeFSP.rmdir(NodePath.join(dir, namespace)));
        const target = yield* fs.makeTempDirectoryScoped({ prefix: "source-external-" });
        yield* runNode(() => NodeFSP.symlink(target, NodePath.join(dir, namespace)));
        assert.strictEqual(
          failCategory(
            yield* Artifacts.commitArtifactBytes({
              artifactDirectory: dir,
              namespace,
              sha: hash,
              bytes,
            }).pipe(Effect.flip),
          ),
          "persistence",
        );
        assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(target)), []);
      }),
    ),
);

it.effect("source chunk fsync failure preserves immutable bytes and requires durable retry", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "source-sync-" });
      const directory = NodePath.join(dir, "retro-source-chunk");
      yield* runNode(() => NodeFSP.mkdir(directory, { mode: 0o700 }));
      yield* Effect.acquireRelease(
        runNode(() => NodeFSP.chmod(directory, 0o300)),
        () => runNode(() => NodeFSP.chmod(directory, 0o700)).pipe(Effect.orDie),
      );
      const bytes = Buffer.from('{"text":"durable source"}');
      const input = {
        artifactDirectory: dir,
        namespace: "retro-source-chunk" as const,
        sha: sha(bytes),
        bytes,
      };
      assert.strictEqual(
        failCategory(yield* Artifacts.commitArtifactBytes(input).pipe(Effect.flip)),
        "persistence",
      );
      assert.strictEqual(
        failCategory(yield* Artifacts.commitArtifactBytes(input).pipe(Effect.flip)),
        "persistence",
      );
      yield* runNode(() => NodeFSP.chmod(directory, 0o700));
      assert.isTrue((yield* Artifacts.commitArtifactBytes(input)).reused);
      const stored = yield* Artifacts.readArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-source-chunk",
        ref: `retro-source-chunk:${input.sha}`,
        maxBytes: 65536,
      });
      assert.strictEqual(stored.text, bytes.toString("utf8"));
      assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(directory)), [
        `${input.sha}.json`,
      ]);
    }),
  ),
);

it.effect("retro-source-read receipts are bounded, hash-bound, private and immutable", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-source-read-" });
      const bytes = Buffer.from(
        stableStringify({ status: "prepared", fragmentHash: HASH_A }),
        "utf8",
      );
      const hash = sha(bytes);
      const committed = yield* Artifacts.commitArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-source-read",
        sha: hash,
        bytes,
      });
      assert.isFalse(committed.reused);
      const duplicate = yield* Artifacts.commitArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-source-read",
        sha: hash,
        bytes,
      });
      assert.isTrue(duplicate.reused);
      const stored = yield* Artifacts.readArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-source-read",
        ref: `retro-source-read:${hash}`,
        maxBytes: 64 * 1024,
      });
      assert.strictEqual(stored.sha, hash);
      assert.strictEqual(stored.text, bytes.toString("utf8"));
      const stat = yield* runNode(() =>
        NodeFSP.stat(NodePath.join(dir, "retro-source-read", `${hash}.json`)),
      );
      assert.strictEqual(stat.mode & 0o777, 0o600);
      // Over-bound and non-canonical refs fail closed.
      const oversized = Buffer.alloc(Artifacts.MAX_MISSION_RETRO_SOURCE_READ_RECEIPT_BYTES + 1, 97);
      assert.strictEqual(
        failCategory(
          yield* Artifacts.commitArtifactBytes({
            artifactDirectory: dir,
            namespace: "retro-source-read",
            sha: sha(oversized),
            bytes: oversized,
          }).pipe(Effect.flip),
        ),
        "invalid_command",
      );
      assert.strictEqual(Artifacts.parseArtifactRef("../escape", "retro-source-read"), null);
      assert.strictEqual(
        Artifacts.parseArtifactRef(`retro-source:${hash}`, "retro-source-read"),
        null,
      );
    }),
  ),
);

it.effect("prepared receipt commits reject invalid UTF-8 and incorrect whole-byte hashes", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-source-read-rejected-" });
      const utf8Invalid = Buffer.from([0xc3, 0x28]);
      const bytes = Buffer.from("prepared", "utf8");
      assert.strictEqual(
        failCategory(
          yield* Artifacts.commitArtifactBytes({
            artifactDirectory: dir,
            namespace: "retro-source-read",
            sha: sha(utf8Invalid),
            bytes: utf8Invalid,
          }).pipe(Effect.flip),
        ),
        "invalid_command",
      );
      assert.strictEqual(
        failCategory(
          yield* Artifacts.commitArtifactBytes({
            artifactDirectory: dir,
            namespace: "retro-source-read",
            sha: HASH_A,
            bytes,
          }).pipe(Effect.flip),
        ),
        "invalid_command",
      );
      assert.deepStrictEqual(yield* fs.readDirectory(dir), []);
    }),
  ),
);

it.effect(
  "prepared receipt reads clamp oversized caller limits and reject hash/UTF-8 corruption",
  () =>
    scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-source-read-clamp-" });
        const bytes = Buffer.from("prepared", "utf8");
        const hash = sha(bytes);
        yield* Artifacts.commitArtifactBytes({
          artifactDirectory: dir,
          namespace: "retro-source-read",
          sha: hash,
          bytes,
        });
        const directory = NodePath.join(dir, "retro-source-read");
        const path = NodePath.join(directory, `${hash}.json`);
        const read = Artifacts.readArtifactBytes({
          artifactDirectory: dir,
          namespace: "retro-source-read",
          ref: `retro-source-read:${hash}`,
          maxBytes: 1024 * 1024,
        });
        const oversized = Buffer.alloc(
          Artifacts.MAX_MISSION_RETRO_SOURCE_READ_RECEIPT_BYTES + 1,
          97,
        );
        yield* runNode(() => NodeFSP.writeFile(path, oversized, { mode: 0o600 }));
        assert.strictEqual(failCategory(yield* read.pipe(Effect.flip)), "persistence");
        yield* runNode(() => NodeFSP.writeFile(path, Buffer.from([0xc3, 0x28]), { mode: 0o600 }));
        assert.strictEqual(failCategory(yield* read.pipe(Effect.flip)), "persistence");
        yield* runNode(() =>
          NodeFSP.writeFile(path, Buffer.from("different", "utf8"), { mode: 0o600 }),
        );
        assert.strictEqual(failCategory(yield* read.pipe(Effect.flip)), "persistence");
        const narrow = Artifacts.readArtifactBytes({
          artifactDirectory: dir,
          namespace: "retro-source-read",
          ref: `retro-source-read:${hash}`,
          maxBytes: 1,
        });
        yield* runNode(() => NodeFSP.writeFile(path, bytes, { mode: 0o600 }));
        assert.strictEqual(failCategory(yield* narrow.pipe(Effect.flip)), "persistence");
        assert.strictEqual((yield* read).text, "prepared");
      }),
    ),
);
