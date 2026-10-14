// @effect-diagnostics nodeBuiltinImport:off -- content hashes bind evidence bytes; link-based commit keeps files immutable.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NonNegativeInt } from "../../../../packages/contracts/src/baseSchemas.ts";
import { MissionId } from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionRetroReportReceipts,
} from "../../../../packages/contracts/src/missionExecution.ts";
import { RetroId, Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import { MissionRetroReport } from "../../../../packages/contracts/src/missionRetroReport.ts";
import { SkillEvaluationTargetSkillRef } from "../../../../packages/contracts/src/missionRetroSkillEvaluation.ts";
import * as MissionService from "./MissionService.ts";
import { readNormalizedArtifactBytes } from "./MissionRetroReportArtifacts.ts";
import { MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES } from "./MissionRetroReportStore.ts";
import {
  MissionRetroSkillEvaluationProducer,
  MissionRetroSkillEvaluationStoreError,
  type MissionRetroSkillEvaluationFacts,
  type MissionRetroSkillEvaluationFactsRequest,
} from "./MissionRetroSkillEvaluationStore.ts";

/**
 * Immutable replay-evidence artifacts and the trusted facts producer they
 * feed for the accepted `MissionRetroSkillEvaluationStore`.
 *
 * Layout: `<artifactDirectory>/skill-replay-evidence/<sha256>.json`, files
 * read-only `0400` under private directories `0700`. The address is the SHA-256 of the
 * exact canonical envelope bytes (`stableStringify` of the strictly decoded
 * envelope), so the ref the recorder stores is itself the integrity check.
 * Commits are exclusive-temp plus hard-link: matching bytes are reused,
 * differing bytes fail closed without touching the accepted file, and a
 * symlinked root, namespace or destination is rejected, never followed.
 *
 * The envelope is bounded digests, counters and ids: no transcripts, answers,
 * fixture bodies, expected strings, executor output or credentials.
 *
 * `layerReplayEvidenceProducer` is the real link to the recorder. It trusts no
 * command flag: it rereads the artifact bytes, recomputes their SHA-256, and
 * binds the envelope to the canonical mission (team, environment, current
 * Retro thread and epoch, revision), the canonical origin report receipt and
 * its reread normalized shortlist. A provable mismatch fails closed; a fact it
 * cannot establish (missing artifact, unreadable report, unknown user intent)
 * stays unknown so the recorder holds and persists nothing.
 */

/** One artifact is bounded far below any transcript; over-bound input is rejected, never truncated. */
export const MAX_SKILL_REPLAY_EVIDENCE_BYTES = 128 * 1024;
/** Repeats per fixture class. Keeps the validator's 64 KiB context bound and 64-pair bound honest. */
export const MAX_SKILL_REPLAY_REPEAT_COUNT = 8;
const MAX_ENVELOPE_PAIRS = 3 * MAX_SKILL_REPLAY_REPEAT_COUNT;
const NAMESPACE = "skill-replay-evidence";
const REF_PATTERN = /^skill-replay-evidence:([0-9a-f]{64})$/;
const MAX_ISSUED_FENCES = 256;

export class MissionRetroReplayArtifactError extends Schema.TaggedError<MissionRetroReplayArtifactError>()(
  "MissionRetroReplayArtifactError",
  {
    operation: Schema.Literals(["commit", "read", "configure"]),
    category: Schema.Literals([
      "invalid_ref",
      "invalid_envelope",
      "invalid_options",
      "unsafe_root",
      "unsafe_destination",
      "conflict",
      "missing",
      "digest_mismatch",
      "oversized",
      "persistence",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Skill replay artifact ${this.operation} failed (${this.category}).`;
  }
}
const isArtifactError = Schema.is(MissionRetroReplayArtifactError);

const Counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

const EvidenceBinding = Schema.Struct({
  teamId: RetroId,
  environmentId: RetroId,
  missionId: RetroId,
  retroEpoch: Counter,
  sourceReportHash: Sha256Hex,
  normalizedReportHash: Sha256Hex,
  candidateId: RetroId,
  evaluationId: RetroId,
  targetSkillRef: SkillEvaluationTargetSkillRef,
  oldSkillSha256: Sha256Hex,
  newSkillSha256: Sha256Hex,
});

/** One runner-observed side of a paired run. Digests and counters only. */
const EvidenceObservation = Schema.Struct({
  runRef: RetroId,
  contextId: RetroId,
  fixtureId: RetroId,
  fixtureHash: Sha256Hex,
  configDigest: Sha256Hex,
  observedSkillSha256: Sha256Hex,
  outcome: Schema.Literals(["pass", "fail"]),
  skillTriggered: Schema.Boolean,
  unnecessaryLoads: Counter,
  repeatedLookups: Counter,
  completionQuality: Schema.Literals(["ok", "degraded", "unknown"]),
});

const EvidencePair = Schema.Struct({
  fixtureClass: Schema.Literals(["failure", "positive", "negative"]),
  old: EvidenceObservation,
  new: EvidenceObservation,
});

/** Root-approved subscription route a model-backed executor ran under. Never an API-billed route. */
const EvidenceRoute = Schema.Struct({
  providerInstanceId: RetroId,
  model: RetroId,
  billing: Schema.Literal("subscription"),
});

const EvidenceReplay = Schema.Struct({
  /**
   * What kind of evidence this is. `deterministic_executable` proves the
   * replay pipeline and a deterministic behavior; only `model_backed` can
   * say anything about a real model effect, and then only as sampled pairs.
   */
  proofClass: Schema.Literals(["deterministic_executable", "model_backed"]),
  route: Schema.NullOr(EvidenceRoute),
  authorId: RetroId,
  reviewerId: RetroId,
  ownership: Schema.Literals(["owned-isolated", "upstream", "unknown"]),
  configDigest: Sha256Hex,
  runMode: Schema.Literals(["deterministic", "stochastic"]),
  requiredRepeatCount: Counter.check(
    Schema.makeFilter((n) => n >= 1 && n <= MAX_SKILL_REPLAY_REPEAT_COUNT, {
      expected: `1..${MAX_SKILL_REPLAY_REPEAT_COUNT} repeats`,
    }),
  ),
  telemetryComplete: Schema.Boolean,
  leakageCheck: Schema.Literals(["pass", "fail", "unknown"]),
  pairs: Schema.Array(EvidencePair).check(
    Schema.makeFilter((pairs) => pairs.length <= MAX_ENVELOPE_PAIRS, {
      expected: `at most ${MAX_ENVELOPE_PAIRS} pairs`,
    }),
  ),
}).check(
  Schema.makeFilter(
    (replay) =>
      replay.proofClass === "model_backed"
        ? replay.route !== null &&
          replay.runMode === "stochastic" &&
          replay.requiredRepeatCount >= 2
        : replay.route === null && replay.runMode === "deterministic",
    { expected: "a proof class consistent with its route, run mode and repeat count" },
  ),
);

/**
 * The strict evidence envelope. `candidate` is the UNTRUSTED author claim,
 * kept only so the existing validator can cross-check it against the trusted
 * binding; nothing here is read as proof of a pass.
 */
export const SkillReplayEvidenceEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  binding: EvidenceBinding,
  candidate: Schema.Struct({
    candidateId: RetroId,
    targetSkillRef: SkillEvaluationTargetSkillRef,
    sourceReportHash: Sha256Hex,
    claimedPass: Schema.Boolean,
  }),
  replay: EvidenceReplay,
});
export type SkillReplayEvidenceEnvelope = typeof SkillReplayEvidenceEnvelope.Type;

const decodeEnvelope = Schema.decodeUnknownSync(SkillReplayEvidenceEnvelope, {
  onExcessProperty: "error",
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(MissionRetroReport));

const sha256Hex = (bytes: Uint8Array | string): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const artifactError = (
  operation: MissionRetroReplayArtifactError["operation"],
  category: MissionRetroReplayArtifactError["category"],
  cause?: unknown,
): MissionRetroReplayArtifactError =>
  cause === undefined
    ? new MissionRetroReplayArtifactError({ operation, category })
    : new MissionRetroReplayArtifactError({ operation, category, cause });

/** Strict `skill-replay-evidence:<sha256>` ref to its SHA, or null. Never a path. */
export const parseSkillReplayEvidenceRef = (ref: string): string | null =>
  REF_PATTERN.exec(ref)?.[1] ?? null;

const isMissing = (cause: unknown): boolean => (cause as NodeJS.ErrnoException)?.code === "ENOENT";

const lstatOrNull = (path: string) =>
  NodeFSP.lstat(path).catch((cause: unknown) => (isMissing(cause) ? null : Promise.reject(cause)));

const privateDirectory = (status: NodeFS.Stats): boolean =>
  !status.isSymbolicLink() && status.isDirectory() && (status.mode & 0o077) === 0;

const privateFile = (status: NodeFS.Stats): boolean =>
  !status.isSymbolicLink() && status.isFile() && (status.mode & 0o077) === 0;

/**
 * The root must itself be a real private directory, never a symlink. Ancestor
 * aliases (macOS `/var` -> `/private/var`) are legitimate, so later joins use
 * the once-resolved real root.
 */
const resolveRoot = async (
  operation: "commit" | "read",
  root: string,
  create: boolean,
): Promise<string> => {
  if (!NodePath.isAbsolute(root)) throw artifactError(operation, "unsafe_root");
  if (create) {
    await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
  }
  const status = await NodeFSP.lstat(root);
  if (!privateDirectory(status)) throw artifactError(operation, "unsafe_root");
  const resolved = await NodeFSP.realpath(root);
  const resolvedStatus = await NodeFSP.lstat(resolved);
  if (!privateDirectory(resolvedStatus)) throw artifactError(operation, "unsafe_root");
  return resolved;
};

const resolveNamespace = async (
  operation: "commit" | "read",
  resolvedRoot: string,
  create: boolean,
): Promise<string> => {
  const directory = NodePath.join(resolvedRoot, NAMESPACE);
  if (create) {
    await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
  }
  const status = await NodeFSP.lstat(directory);
  if (!privateDirectory(status) || (await NodeFSP.realpath(directory)) !== directory) {
    throw artifactError(operation, "unsafe_destination");
  }
  return directory;
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Reads an existing destination through a no-follow handle; bounded and regular-file only. */
const readDestination = async (
  operation: "commit" | "read",
  destination: string,
): Promise<Buffer> => {
  const status = await NodeFSP.lstat(destination);
  if (!privateFile(status)) throw artifactError(operation, "unsafe_destination");
  if (status.size > MAX_SKILL_REPLAY_EVIDENCE_BYTES) throw artifactError(operation, "oversized");
  const handle = await NodeFSP.open(
    destination,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_SKILL_REPLAY_EVIDENCE_BYTES) {
      throw artifactError(operation, opened.isFile() ? "oversized" : "unsafe_destination");
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SKILL_REPLAY_EVIDENCE_BYTES) throw artifactError(operation, "oversized");
    return bytes;
  } finally {
    await handle.close();
  }
};

const sameBytesOrConflict = async (destination: string, bytes: Buffer): Promise<void> => {
  const current = await readDestination("commit", destination);
  if (Buffer.compare(current, bytes) !== 0) throw artifactError("commit", "conflict");
};

const removeQuiet = (path: string): Promise<void> =>
  NodeFSP.unlink(path).then(
    () => undefined,
    () => undefined,
  );

/**
 * Immutable content-addressed commit. Existing matching bytes are reused;
 * existing differing bytes fail closed. The link into place is atomic, so
 * parallel retries cannot truncate or partially overwrite.
 */
const commitBytes = async (
  root: string,
  sha: string,
  bytes: Buffer,
): Promise<{ readonly reused: boolean }> => {
  const resolvedRoot = await resolveRoot("commit", root, true);
  const directory = await resolveNamespace("commit", resolvedRoot, true);
  const destination = NodePath.join(directory, `${sha}.json`);
  if ((await lstatOrNull(destination)) !== null) {
    await sameBytesOrConflict(destination, bytes);
    // A previous writer may have linked without finishing its directory sync.
    await syncDirectory(directory);
    return { reused: true };
  }
  const temporary = NodePath.join(directory, `.tmp-${NodeCrypto.randomUUID()}`);
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let linked = true;
    try {
      await NodeFSP.link(temporary, destination);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
      linked = false;
    }
    if (!linked) await sameBytesOrConflict(destination, bytes);
    await syncDirectory(directory);
    return { reused: !linked };
  } finally {
    await removeQuiet(temporary);
  }
};

const classify = (operation: "commit" | "read", cause: unknown): MissionRetroReplayArtifactError =>
  isArtifactError(cause)
    ? cause
    : isMissing(cause)
      ? artifactError(operation, "missing", cause)
      : artifactError(operation, "persistence", cause);

export interface SkillReplayEvidenceCommitted {
  readonly artifactRef: string;
  readonly artifactSha: string;
  /** True when identical bytes were already committed. */
  readonly reused: boolean;
}

/**
 * Strictly decode, canonically encode, and commit one envelope. Excess
 * properties and over-bound envelopes are rejected, never stripped or cut.
 */
export const commitSkillReplayEvidence = Effect.fn("MissionRetroReplayArtifacts.commit")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly envelope: unknown;
  }): Effect.fn.Return<SkillReplayEvidenceCommitted, MissionRetroReplayArtifactError> {
    const envelope = yield* Effect.try({
      try: () => decodeEnvelope(input.envelope),
      catch: (cause) => artifactError("commit", "invalid_envelope", cause),
    });
    const bytes = Buffer.from(stableStringify(envelope), "utf8");
    if (bytes.length > MAX_SKILL_REPLAY_EVIDENCE_BYTES) {
      return yield* artifactError("commit", "oversized");
    }
    const artifactSha = sha256Hex(bytes);
    const { reused } = yield* Effect.tryPromise({
      try: () => commitBytes(input.artifactDirectory, artifactSha, bytes),
      catch: (cause) => classify("commit", cause),
    });
    return { artifactRef: `${NAMESPACE}:${artifactSha}`, artifactSha, reused };
  },
);

export interface SkillReplayEvidenceRead {
  readonly envelope: SkillReplayEvidenceEnvelope;
  /** SHA-256 of the bytes that were actually reread, equal to the ref's address. */
  readonly artifactSha: string;
}

/**
 * Reread an artifact by ref. The returned SHA is computed from the bytes just
 * read, then required to equal the address; the bytes must also be the
 * canonical encoding of the strictly decoded envelope, so no second encoding
 * of the same evidence can exist under one address.
 */
export const readSkillReplayEvidence = Effect.fn("MissionRetroReplayArtifacts.read")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly artifactRef: string;
  }): Effect.fn.Return<SkillReplayEvidenceRead, MissionRetroReplayArtifactError> {
    const address = parseSkillReplayEvidenceRef(input.artifactRef);
    if (address === null) return yield* artifactError("read", "invalid_ref");
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const resolvedRoot = await resolveRoot("read", input.artifactDirectory, false);
        const directory = await resolveNamespace("read", resolvedRoot, false);
        const destination = NodePath.join(directory, `${address}.json`);
        const bytes = await readDestination("read", destination);
        if ((await NodeFSP.realpath(destination)) !== destination) {
          throw artifactError("read", "unsafe_destination");
        }
        return bytes;
      },
      catch: (cause) => classify("read", cause),
    });
    const artifactSha = sha256Hex(bytes);
    if (artifactSha !== address) return yield* artifactError("read", "digest_mismatch");
    const envelope = yield* Effect.try({
      try: () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const decoded = decodeEnvelope(decodeJson(text));
        if (stableStringify(decoded) !== text) throw new Error("not the canonical encoding");
        return decoded;
      },
      catch: (cause) => artifactError("read", "invalid_envelope", cause),
    });
    return { envelope, artifactSha };
  },
);

/** The pure sync currency check plus the facts the root owns; see {@link layerReplayEvidenceProducer}. */
export interface ReplayEvidenceProducerOptions {
  /** Absolute evidence root, the same one the runner commits to. */
  readonly artifactDirectory: string;
  /** Absolute root of the existing Retro report artifacts, for the canonical normalized report. */
  readonly reportArtifactDirectory: string;
  /** Root-pinned independent reviewer identity; any other reviewer in an envelope is denied. */
  readonly reviewerId: string;
  /** Root-pinned executor config digests; evidence run under any other config is denied. */
  readonly approvedConfigDigests: ReadonlyArray<string>;
  /**
   * Root-owned pure synchronous currency check. It must turn false as soon as
   * the Retro role binding, a user stop or pause, or the owning lifetime has
   * moved on. The recorder also asks it after every one of its own SQL steps.
   */
  readonly isCurrent: () => boolean;
  /**
   * User stop and pause intent that is not yet in the canonical mission
   * status. When absent, an `active` mission's intent is reported unknown
   * (null), which the recorder holds on. Never defaulted to false here.
   */
  readonly readUserIntent?: Effect.Effect<{
    readonly stop: boolean | null;
    readonly pause: boolean | null;
  }>;
}

const scopeDenied = () => new MissionRetroSkillEvaluationStoreError({ category: "scope_denied" });
const persistence = (cause: unknown) =>
  new MissionRetroSkillEvaluationStoreError({ category: "persistence", cause });

const validOptions = (options: ReplayEvidenceProducerOptions): boolean =>
  NodePath.isAbsolute(options.artifactDirectory) &&
  NodePath.isAbsolute(options.reportArtifactDirectory) &&
  options.reviewerId.trim().length > 0 &&
  options.reviewerId.length <= 256 &&
  options.approvedConfigDigests.length > 0 &&
  options.approvedConfigDigests.every((digest) => /^[0-9a-f]{64}$/.test(digest)) &&
  typeof options.isCurrent === "function";

const make = (options: ReplayEvidenceProducerOptions) =>
  Effect.gen(function* () {
    if (!validOptions(options)) {
      return yield* artifactError("configure", "invalid_options");
    }
    const missions = yield* MissionService.MissionService;
    const approved = new Set(options.approvedConfigDigests);
    // Fences this producer issued and has not revoked. A fence is current only
    // while it is live, the producer's scope is open, and the root says so.
    const issued = new Set<string>();
    let open = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        open = false;
        issued.clear();
      }),
    );
    const issueFence = (): string => {
      const fence = `replay-fence-${NodeCrypto.randomUUID()}`;
      if (issued.size >= MAX_ISSUED_FENCES) {
        const oldest = issued.values().next().value;
        if (oldest !== undefined) issued.delete(oldest);
      }
      issued.add(fence);
      return fence;
    };
    const rootIsCurrent = (): boolean => {
      try {
        return options.isCurrent() === true;
      } catch {
        return false;
      }
    };

    const readFacts = Effect.fn("MissionRetroReplayArtifacts.readFacts")(function* (
      request: MissionRetroSkillEvaluationFactsRequest,
    ): Effect.fn.Return<MissionRetroSkillEvaluationFacts, MissionRetroSkillEvaluationStoreError> {
      if (!open || !rootIsCurrent()) return yield* scopeDenied();
      const mission = yield* missions.get(MissionId.make(request.missionId)).pipe(
        Effect.mapError((cause) =>
          cause.category === "scope_denied" ? scopeDenied() : persistence(cause),
        ),
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(scopeDenied()), onSome: Effect.succeed }),
        ),
      );
      const retro = mission.managers.retro;
      if (retro?.threadId === undefined || retro.epoch === undefined) return yield* scopeDenied();

      const intent = yield* options.readUserIntent ?? Effect.succeed({ stop: null, pause: null });
      const base = {
        teamId: mission.teamId,
        environmentId: mission.authorityEnvironmentId,
        missionId: mission.id,
        retroThreadId: retro.threadId,
        retroEpoch: retro.epoch,
        observedRevision: mission.revision,
        userStopRequested: mission.status === "stopped" ? true : intent.stop,
        userPauseRequested: mission.status === "paused" ? true : intent.pause,
      };
      const unknown = (): MissionRetroSkillEvaluationFacts => ({
        ...base,
        evaluation: null,
        fence: issueFence(),
      });
      // An inactive or stopped/paused/unknown-intent mission is held by the
      // recorder before it looks at any evaluation; no evidence I/O is needed.
      if (
        mission.status !== "active" ||
        base.userStopRequested !== false ||
        base.userPauseRequested !== false
      ) {
        return { ...base, fence: issueFence() };
      }

      // The artifact is reread from disk. Missing or unreadable stays unknown;
      // any proof of tampering is a denial.
      const reread = yield* readSkillReplayEvidence({
        artifactDirectory: options.artifactDirectory,
        artifactRef: request.evidenceArtifactRef,
      }).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          error.category === "missing" || error.category === "persistence"
            ? Effect.succeedNone
            : Effect.fail(scopeDenied()),
        ),
      );
      if (Option.isNone(reread)) return unknown();
      const { envelope, artifactSha } = reread.value;
      if (artifactSha !== request.evidenceArtifactSha) return yield* scopeDenied();

      // Canonical scope, current Retro epoch and the origin report, never the
      // envelope's own claims about them.
      const binding = envelope.binding;
      const receipt = missionRetroReportReceipts(mission.execution ?? emptyMissionExecution()).find(
        (entry) => entry.sourceReportHash === binding.sourceReportHash,
      );
      if (
        binding.teamId !== mission.teamId ||
        binding.environmentId !== mission.authorityEnvironmentId ||
        binding.missionId !== mission.id ||
        binding.retroEpoch !== retro.epoch ||
        binding.candidateId !== request.candidateId ||
        binding.evaluationId !== request.evaluationId ||
        envelope.candidate.candidateId !== request.candidateId ||
        (receipt !== undefined && receipt.normalizedReportHash !== binding.normalizedReportHash) ||
        envelope.replay.reviewerId !== options.reviewerId ||
        !approved.has(envelope.replay.configDigest)
      ) {
        return yield* scopeDenied();
      }

      // A recordable report must actually shortlist this candidate. The
      // normalized report is reread and re-hashed from its own artifact.
      if (
        receipt !== undefined &&
        receipt.disposition === "queued_for_triage" &&
        receipt.coverageFull &&
        receipt.verdict === "candidates"
      ) {
        const report = yield* readNormalizedArtifactBytes({
          artifactDirectory: options.reportArtifactDirectory,
          ref: receipt.normalizedArtifactRef,
          expectedArtifactSha: receipt.normalizedArtifactSha,
          maxBytes: MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES,
        }).pipe(
          Effect.flatMap((read) => Effect.try(() => decodeReport(read.text))),
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isNone(report)) return unknown();
        if (!report.value.shortlist.some((entry) => entry.candidateId === request.candidateId)) {
          return yield* scopeDenied();
        }
      }

      const replay = envelope.replay;
      return {
        ...base,
        evaluation: {
          candidate: envelope.candidate,
          context: {
            scope: {
              teamId: mission.teamId,
              environmentId: mission.authorityEnvironmentId,
              originMissionId: mission.id,
              candidateId: request.candidateId,
              targetSkillRef: binding.targetSkillRef,
              sourceReportHash: receipt?.sourceReportHash ?? binding.sourceReportHash,
              normalizedReportHash: receipt?.normalizedReportHash ?? binding.normalizedReportHash,
            },
            authorId: replay.authorId,
            reviewerId: replay.reviewerId,
            oldSnapshotDigest: binding.oldSkillSha256,
            newSnapshotDigest: binding.newSkillSha256,
            ownership: replay.ownership,
            configDigest: replay.configDigest,
            runMode: replay.runMode,
            requiredRepeatCount: replay.requiredRepeatCount,
            telemetryComplete: replay.telemetryComplete,
            leakageCheck: replay.leakageCheck,
            pairs: replay.pairs,
          },
          evidence: {
            artifactRef: request.evidenceArtifactRef,
            artifactSha,
            verification: "verified" as const,
            binding,
          },
        },
        fence: issueFence(),
      };
    });

    return MissionRetroSkillEvaluationProducer.of({
      readFacts,
      isCurrent: (facts) => open && issued.has(facts.fence) && rootIsCurrent(),
    });
  });

/**
 * The recorder's required private producer, backed by real facts: the
 * canonical `MissionService` mission and the artifact bytes on disk. The root
 * composes it next to the store's authority, for example
 * `SkillStore.layer.pipe(Layer.provide(authority), Layer.provide(layerReplayEvidenceProducer(options)))`
 * with `MissionService.layer` and the same Retro authority below it.
 *
 * Fences are issued per read and revoked when this layer's scope closes. The
 * root's `isCurrent` must mirror the recorder authority, so a Retro rotation
 * or user stop/pause revokes a read that is still in flight.
 */
export const layerReplayEvidenceProducer = (options: ReplayEvidenceProducerOptions) =>
  Layer.effect(MissionRetroSkillEvaluationProducer, make(options));
