// @effect-diagnostics nodeBuiltinImport:off -- content hashes bind artifact bytes; link-based commit keeps files immutable.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";
import { MissionRetroReport } from "../../../../packages/contracts/src/missionRetroReport.ts";
import {
  MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES,
  MissionRetroReportArtifactPort,
  MissionRetroReportStoreError,
  type MissionRetroReportPrepareInput,
  type MissionRetroReportReadInput,
  type MissionRetroReportReceiveCommand,
  type MissionRetroReportTrustedOriginal,
} from "./MissionRetroReportStore.ts";
import {
  computeRetroReportHash,
  type MissionRetroReportTrustedCoverage,
} from "./MissionRetroReportReconciliation.ts";

/**
 * Filesystem source backing for the accepted `MissionRetroReportArtifactPort`.
 *
 * Layout: `<artifactDirectory>/<namespace>/<sha>.json` with namespaces
 * `retro-original`, `retro-normalized`, and `retro-coverage`. Files are
 * private (`0600`) under a private root (`0700`). Commits are immutable:
 * bytes are written to an exclusive temp file and hard-linked into place,
 * so concurrent retries reuse matching bytes and conflicting bytes fail
 * closed without touching the accepted file. Symlink destinations and
 * escapes are rejected; refs never address arbitrary paths.
 *
 * Scope/origin/coverage facts always come from the injected
 * `MissionRetroReportTrustedResolver`, keyed by the exact command and the
 * actual original SHA. There is no production resolver yet: callers must
 * supply genuine immutable checkpoint/source/assignment/read receipts, and
 * wiring without one fails explicitly. The root store stays the validation
 * gate; this layer never rewrites hashes or synthesizes metadata from
 * reporter claims.
 */

/** Byte bound for complete coverage-evidence descriptors; over-bound input is rejected, never truncated. */
export const MAX_MISSION_RETRO_REPORT_COVERAGE_BYTES = 8 * 1024 * 1024;

const SHA_HEX = "[0-9a-f]{64}";
const REF_PATTERNS = {
  "retro-original": new RegExp(`^retro-original:(${SHA_HEX})$`),
  "retro-normalized": new RegExp(`^retro-normalized:(${SHA_HEX})$`),
  "retro-coverage": new RegExp(`^retro-coverage:(${SHA_HEX})$`),
} as const;
export type MissionRetroReportArtifactNamespace = keyof typeof REF_PATTERNS;

/** Trusted scope/origin/coverage facts the runtime resolves outside this layer. */
export interface MissionRetroReportTrustedMetadata {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly checkpointId: string;
  readonly retroThreadId: string;
  readonly retroEpoch: number;
  readonly sourceThreadId: string;
  readonly sourceRoot: string;
  readonly snapshotFingerprint: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
  /** Trusted actual origin of the source work, never the caller's label. */
  readonly actualOrigin: string;
  readonly coverage: MissionRetroReportTrustedCoverage;
}

export interface MissionRetroReportResolverInput {
  readonly command: MissionRetroReportReceiveCommand;
  /** SHA-256 over the complete stored original bytes, not a caller claim. */
  readonly originalSha: string;
  /** Parsed original descriptor; scope facts must still come from receipts, never this object. */
  readonly report: unknown;
}

export class MissionRetroReportTrustedResolver extends Context.Service<
  MissionRetroReportTrustedResolver,
  {
    readonly resolve: (
      input: MissionRetroReportResolverInput,
    ) => Effect.Effect<MissionRetroReportTrustedMetadata, MissionRetroReportStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroReportArtifacts/MissionRetroReportTrustedResolver") {}

/**
 * Placeholder resolver wiring: there is no production trusted resolver yet.
 * Using it fails explicitly instead of manufacturing metadata. The pending
 * producer must resolve genuine immutable checkpoint/source/assignment/read
 * receipts keyed by the exact command and actual original SHA.
 */
export const layerMissingTrustedResolver: Layer.Layer<MissionRetroReportTrustedResolver> =
  Layer.succeed(MissionRetroReportTrustedResolver, {
    resolve: () =>
      Effect.fail(
        new MissionRetroReportStoreError({
          operation: "receive",
          category: "persistence",
          cause: new Error(
            "No production trusted resolver is configured: supply genuine checkpoint/source/assignment/read receipts.",
          ),
        }),
      ),
  });

export interface MissionRetroReportIngestedOriginal {
  readonly originalArtifactRef: string;
  readonly originalArtifactSha: string;
}

type StoreErrorCategory = MissionRetroReportStoreError["category"];

const storeError = (
  category: StoreErrorCategory,
  cause?: unknown,
): MissionRetroReportStoreError =>
  cause === undefined
    ? new MissionRetroReportStoreError({ operation: "receive", category })
    : new MissionRetroReportStoreError({ operation: "receive", category, cause });

const sha256Hex = (bytes: NodeJS.TypedArray | string): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

const strictUtf8 = (text: string): boolean =>
  Buffer.from(text, "utf8").toString("utf8") === text;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeReportSync = Schema.decodeUnknownSync(MissionRetroReport, {
  onExcessProperty: "error",
});
const decodeReportValue = Schema.decodeUnknownEffect(MissionRetroReport, {
  onExcessProperty: "error",
});

/** Strict canonical ref for one namespace, or null. Rejects traversal, wrong types, and non-hex SHAs. */
export const parseArtifactRef = (
  ref: string,
  namespace: MissionRetroReportArtifactNamespace,
): string | null => REF_PATTERNS[namespace].exec(ref)?.[1] ?? null;

/** Filesystem path for a canonical ref, or null when the ref is not strict. Never resolves caller paths. */
export const artifactPathForRef = (
  artifactDirectory: string,
  ref: string,
  namespace: MissionRetroReportArtifactNamespace,
): string | null => {
  const sha = parseArtifactRef(ref, namespace);
  if (sha === null) return null;
  return NodePath.join(artifactDirectory, namespace, `${sha}.json`);
};

const checkRoot = (artifactDirectory: string): string | null =>
  artifactDirectory.length === 0 || !NodePath.isAbsolute(artifactDirectory)
    ? null
    : artifactDirectory;

const removeQuiet = (path: string): Promise<void> =>
  NodeFSP.unlink(path).then(
    () => undefined,
    () => undefined,
  );

const isMissing = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Controlled root: the artifact root itself must be a real directory, never
 * a symlink. Ancestor aliases (for example macOS `/var` -> `/private/var`)
 * are legitimate, so all later joins use the once-resolved real root.
 */
const resolveControlledRoot = async (root: string, create: boolean): Promise<string> => {
  if (create) {
    await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
  }
  const status = await NodeFSP.lstat(root);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error("Artifact root is not a directory.");
  const resolved = await NodeFSP.realpath(root);
  const resolvedStatus = await NodeFSP.lstat(resolved);
  if (resolvedStatus.isSymbolicLink() || !resolvedStatus.isDirectory())
    throw new Error("Artifact root is not a directory.");
  return resolved;
};

const ensureNamespace = async (
  resolvedRoot: string,
  namespace: MissionRetroReportArtifactNamespace,
  create: boolean,
): Promise<string> => {
  const directory = NodePath.join(resolvedRoot, namespace);
  if (create) {
    await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
  }
  const status = await NodeFSP.lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error("Stored artifact destination is not a regular file.");
  const resolved = await NodeFSP.realpath(directory);
  if (resolved !== directory)
    throw new Error("Stored artifact destination is not a regular file.");
  return directory;
};

interface StoredBytes {
  readonly text: string;
  readonly reused: boolean;
}

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Immutable content-addressed commit. An existing matching file is reused;
 * existing differing bytes fail closed without overwriting the accepted
 * file. The link into place is atomic, so parallel retries cannot truncate
 * or partially overwrite. Symlink destinations are rejected, never followed.
 * For `retro-original`/`retro-coverage`, `sha` is the whole-byte SHA. For
 * `retro-normalized`, `sha` is the semantic report hash (the filename key);
 * the whole-byte SHA is returned separately by `prepareNormalized`.
 */
const commitBytesAsync = async (input: {
  readonly artifactDirectory: string;
  readonly namespace: MissionRetroReportArtifactNamespace;
  readonly sha: string;
  readonly bytes: Buffer;
}): Promise<StoredBytes> => {
  const resolvedRoot = await resolveControlledRoot(input.artifactDirectory, true);
  const directory = await ensureNamespace(resolvedRoot, input.namespace, true);
  const destination = NodePath.join(directory, `${input.sha}.json`);
  const existing = await NodeFSP.lstat(destination).catch((cause: unknown) =>
    isMissing(cause) ? null : Promise.reject(cause),
  );
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error("Stored artifact destination is not a regular file.");
    const current = await NodeFSP.readFile(destination);
    if (Buffer.compare(current, input.bytes) !== 0)
      throw new Error("Stored artifact bytes do not match the content address.");
    // A previous or concurrent writer may have linked without completing its
    // directory sync. A retry must establish durability before reporting reuse.
    await syncDirectory(directory);
    return { text: current.toString("utf8"), reused: true };
  }
  const temporary = NodePath.join(directory, `.tmp-${NodeCrypto.randomUUID()}`);
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
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
    if (!linked) {
      const raced = await NodeFSP.lstat(destination);
      if (raced.isSymbolicLink() || !raced.isFile())
        throw new Error("Stored artifact destination is not a regular file.");
      const current = await NodeFSP.readFile(destination);
      if (Buffer.compare(current, input.bytes) !== 0)
        throw new Error("Stored artifact bytes do not match the content address.");
      await syncDirectory(directory);
      return { text: current.toString("utf8"), reused: true };
    }
    await syncDirectory(directory);
    return { text: input.bytes.toString("utf8"), reused: false };
  } finally {
    await removeQuiet(temporary);
  }
};

export const commitArtifactBytes = Effect.fn("MissionRetroReportArtifacts.commit")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly namespace: MissionRetroReportArtifactNamespace;
    readonly sha: string;
    readonly bytes: Buffer;
  }): Effect.fn.Return<StoredBytes, MissionRetroReportStoreError> {
    if (
      checkRoot(input.artifactDirectory) === null ||
      !Object.hasOwn(REF_PATTERNS, input.namespace) ||
      !/^[0-9a-f]{64}$/.test(input.sha)
    )
      return yield* storeError("invalid_command", new Error("Artifact directory must be absolute."));
    return yield* Effect.tryPromise({
      try: () => commitBytesAsync(input),
      catch: (cause) => storeError("persistence", cause),
    });
  },
);

interface ReadBytes {
  readonly text: string;
  readonly sha: string;
}

interface RawBytes extends ReadBytes {
  readonly refHash: string;
}

const readRawAsync = async (input: {
  readonly artifactDirectory: string;
  readonly namespace: MissionRetroReportArtifactNamespace;
  readonly ref: string;
  readonly maxBytes: number;
}): Promise<RawBytes> => {
  const refHash = parseArtifactRef(input.ref, input.namespace);
  if (refHash === null) throw new Error("Artifact ref is not a strict canonical content address.");
  const resolvedRoot = await resolveControlledRoot(input.artifactDirectory, false);
  const directory = await ensureNamespace(resolvedRoot, input.namespace, false).catch(
    (cause: unknown) => {
      if (isMissing(cause)) throw new Error("Stored artifact is missing.");
      throw cause;
    },
  );
  const destination = NodePath.join(directory, `${refHash}.json`);
  const status = await NodeFSP.lstat(destination).catch((cause: unknown) =>
    isMissing(cause) ? null : Promise.reject(cause),
  );
  if (status === null) throw new Error("Stored artifact is missing.");
  if (status.isSymbolicLink() || !status.isFile())
    throw new Error("Stored artifact destination is not a regular file.");
  const realDestination = await NodeFSP.realpath(destination);
  if (realDestination !== NodePath.join(resolvedRoot, input.namespace, `${refHash}.json`))
    throw new Error("Stored artifact is missing.");
  if (status.size > input.maxBytes) throw new Error("Stored artifact exceeds its byte bound.");
  const bytes = await NodeFSP.readFile(destination);
  if (bytes.length > input.maxBytes) throw new Error("Stored artifact exceeds its byte bound.");
  const sha = sha256Hex(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { text, sha, refHash };
};

const validateNormalized = (raw: RawBytes): void => {
  const report = decodeReportSync(decodeJson(raw.text));
  if (report.reportHash !== raw.refHash || computeRetroReportHash(report) !== raw.refHash)
    throw new Error("Stored normalized bytes do not match the semantic report hash.");
};

/**
 * Exact byte read for one canonical ref. For byte-addressed namespaces
 * (`retro-original`, `retro-coverage`) the ref hash must equal the whole-byte
 * SHA. For `retro-normalized` the ref hash is the semantic report hash: the
 * decoded report is validated against it and `sha` returns the distinct
 * whole-byte SHA. Missing, oversized, non-UTF-8, or mismatched files fail.
 */
export const readArtifactBytes = Effect.fn("MissionRetroReportArtifacts.read")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly namespace: MissionRetroReportArtifactNamespace;
    readonly ref: string;
    readonly maxBytes: number;
  }): Effect.fn.Return<ReadBytes, MissionRetroReportStoreError> {
    if (checkRoot(input.artifactDirectory) === null || parseArtifactRef(input.ref, input.namespace) === null)
      return yield* storeError(
        "invalid_command",
        new Error("Artifact ref is not a strict canonical content address."),
      );
    const raw = yield* Effect.tryPromise({
      try: () => readRawAsync(input),
      catch: (cause) => storeError("persistence", cause),
    });
    if (input.namespace === "retro-normalized") {
      yield* Effect.try({
        try: () => validateNormalized(raw),
        catch: (cause) => storeError("persistence", cause),
      });
      return { text: raw.text, sha: raw.sha };
    }
    if (raw.sha !== raw.refHash)
      return yield* storeError(
        "persistence",
        new Error("Stored artifact bytes do not match the content address."),
      );
    return { text: raw.text, sha: raw.sha };
  },
);

export interface MissionRetroReportNormalizedRead extends ReadBytes {
  readonly reportHash: string;
  readonly artifactSha: string;
}

/**
 * Reopen a normalized artifact by its semantic ref, requiring the trusted
 * whole-byte SHA from the receipt. Both hashes are checked separately.
 */
export const readNormalizedArtifactBytes = Effect.fn("MissionRetroReportArtifacts.readNormalized")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly ref: string;
    readonly expectedArtifactSha: string;
    readonly maxBytes: number;
  }): Effect.fn.Return<MissionRetroReportNormalizedRead, MissionRetroReportStoreError> {
    if (
      checkRoot(input.artifactDirectory) === null ||
      parseArtifactRef(input.ref, "retro-normalized") === null ||
      !/^[0-9a-f]{64}$/.test(input.expectedArtifactSha)
    )
      return yield* storeError(
        "invalid_command",
        new Error("Artifact ref is not a strict canonical content address."),
      );
    const raw = yield* Effect.tryPromise({
      try: () =>
        readRawAsync({
          artifactDirectory: input.artifactDirectory,
          namespace: "retro-normalized",
          ref: input.ref,
          maxBytes: input.maxBytes,
        }),
      catch: (cause) => storeError("persistence", cause),
    });
    if (raw.sha !== input.expectedArtifactSha)
      return yield* storeError(
        "persistence",
        new Error("Stored normalized bytes do not match the trusted whole-byte SHA."),
      );
    yield* Effect.try({
      try: () => validateNormalized(raw),
      catch: (cause) => storeError("persistence", cause),
    });
    return { text: raw.text, sha: raw.sha, reportHash: raw.refHash, artifactSha: raw.sha };
  },
);

/**
 * Bounded ingest of original descriptor bytes. Yields the complete-byte SHA
 * and its `retro-original:<SHA>` content address. Oversized, non-UTF-8, or
 * non-JSON input is rejected; bytes are stored verbatim for the store to
 * decode itself.
 */
export const ingestRetroReportOriginal = Effect.fn("MissionRetroReportArtifacts.ingestOriginal")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly descriptorBytes: string;
  }): Effect.fn.Return<MissionRetroReportIngestedOriginal, MissionRetroReportStoreError> {
    const bytes = Buffer.from(input.descriptorBytes, "utf8");
    if (bytes.length > MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES)
      return yield* storeError(
        "invalid_command",
        new Error("Original descriptor exceeds its byte bound."),
      );
    if (!strictUtf8(input.descriptorBytes))
      return yield* storeError(
        "invalid_command",
        new Error("Original descriptor is not strict UTF-8."),
      );
    yield* Effect.try({
      try: () => decodeJson(input.descriptorBytes),
      catch: (cause) => storeError("invalid_command", cause),
    });
    const sha = sha256Hex(bytes);
    yield* commitArtifactBytes({
      artifactDirectory: input.artifactDirectory,
      namespace: "retro-original",
      sha,
      bytes,
    });
    return { originalArtifactRef: `retro-original:${sha}`, originalArtifactSha: sha };
  },
);

const readOriginal = Effect.fn("MissionRetroReportArtifacts.readOriginal")(
  function* (
    root: string,
    resolver: MissionRetroReportTrustedResolver["Service"],
    input: MissionRetroReportReadInput,
  ): Effect.fn.Return<MissionRetroReportTrustedOriginal, MissionRetroReportStoreError> {
    const stored = yield* readArtifactBytes({
      artifactDirectory: root,
      namespace: "retro-original",
      ref: input.command.originalArtifactRef,
      maxBytes: MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES,
    });
    // The command's claimed SHA must match the actual whole bytes before
    // any trusted resolver work; a wrong hash never reaches the resolver.
    if (stored.sha !== input.command.originalArtifactSha)
      return yield* storeError(
        "persistence",
        new Error("Stored original bytes do not match the command SHA."),
      );
    const report = yield* Effect.try({
      try: () => decodeJson(stored.text),
      catch: (cause) => storeError("persistence", cause),
    });
    const metadata = yield* resolver.resolve({
      command: input.command,
      originalSha: stored.sha,
      report,
    });
    if (
      metadata.missionId !== input.command.missionId ||
      metadata.checkpointId !== input.command.checkpointId ||
      metadata.retroEpoch !== input.command.retroEpoch
    )
      return yield* storeError(
        "persistence",
        new Error("Trusted resolver metadata does not bind the exact command."),
      );
    return {
      ...metadata,
      originalArtifactRef: input.command.originalArtifactRef,
      descriptorBytes: stored.text,
      report,
    };
  },
);

const prepareNormalized = Effect.fn("MissionRetroReportArtifacts.prepareNormalized")(
  function* (
    root: string,
    input: MissionRetroReportPrepareInput,
  ): Effect.fn.Return<
    {
      readonly artifactRef: string;
      readonly artifactSha: string;
      readonly coverageEvidence: {
        readonly artifactRef: string;
        readonly artifactSha: string;
        readonly descriptorBytes: string;
      };
      readonly descriptorBytes: string;
    },
    MissionRetroReportStoreError
  > {
    if (
      input.checkpointId.length === 0 ||
      input.sourceReportHash.length === 0 ||
      input.coverageEvidence.checkpointId !== input.checkpointId ||
      input.coverageEvidence.sourceReportHash !== input.sourceReportHash ||
      input.coverageEvidence.normalizedReportHash !== input.report.reportHash
    )
      return yield* storeError(
        "invalid_command",
        new Error("Coverage evidence does not bind this checkpoint and report."),
      );
    const decoded = yield* decodeReportValue(input.report).pipe(
      Effect.mapError((cause) => storeError("invalid_command", cause)),
    );
    const actualHash = computeRetroReportHash(decoded);
    if (decoded.reportHash !== actualHash)
      return yield* storeError(
        "invalid_command",
        new Error("Normalized report hash does not match its actual bytes."),
      );
    const descriptorBytes = stableStringify(decoded);
    if (byteLength(descriptorBytes) > MAX_MISSION_RETRO_REPORT_DESCRIPTOR_BYTES)
      return yield* storeError(
        "invalid_command",
        new Error("Normalized descriptor exceeds its byte bound."),
      );
    if (!strictUtf8(descriptorBytes))
      return yield* storeError(
        "invalid_command",
        new Error("Normalized descriptor is not strict UTF-8."),
      );
    // The full evidence input is serialized verbatim: every coverage reason
    // is kept, however many there are. Over-bound evidence is rejected, never truncated.
    const evidenceBytes = stableStringify(input.coverageEvidence);
    if (byteLength(evidenceBytes) > MAX_MISSION_RETRO_REPORT_COVERAGE_BYTES)
      return yield* storeError(
        "invalid_command",
        new Error("Coverage evidence exceeds its byte bound."),
      );
    const normalizedBytes = Buffer.from(descriptorBytes, "utf8");
    const artifactSha = sha256Hex(normalizedBytes);
    const artifactRef = `retro-normalized:${(decoded as ReportValue).reportHash}`;
    // Filename/address is the semantic report hash; artifactSha stays the
    // distinct whole-byte SHA returned to the receipt.
    const stored = yield* commitArtifactBytes({
      artifactDirectory: root,
      namespace: "retro-normalized",
      sha: decoded.reportHash,
      bytes: normalizedBytes,
    });
    const evidenceBuffer = Buffer.from(evidenceBytes, "utf8");
    const evidenceSha = sha256Hex(evidenceBuffer);
    const evidenceRef = `retro-coverage:${evidenceSha}`;
    const storedEvidence = yield* commitArtifactBytes({
      artifactDirectory: root,
      namespace: "retro-coverage",
      sha: evidenceSha,
      bytes: evidenceBuffer,
    });
    return {
      artifactRef,
      artifactSha,
      coverageEvidence: {
        artifactRef: evidenceRef,
        artifactSha: evidenceSha,
        descriptorBytes: storedEvidence.text,
      },
      descriptorBytes: stored.text,
    };
  },
);

const makePort = (artifactDirectory: string) =>
  Effect.gen(function* () {
    if (checkRoot(artifactDirectory) === null)
      return yield* storeError(
        "invalid_command",
        new Error("Artifact directory must be absolute."),
      );
    const resolver = yield* MissionRetroReportTrustedResolver;
    return MissionRetroReportArtifactPort.of({
      readOriginal: (input) => readOriginal(artifactDirectory, resolver, input),
      prepareNormalized: (input) => prepareNormalized(artifactDirectory, input),
    });
  });

/**
 * Filesystem port layer. `artifactDirectory` is explicit and must be
 * absolute (tests use a temp directory); the trusted resolver comes from the
 * environment and has no default. No global state, startup work, network, or
 * provider calls.
 */
export const layerFilesystemReportArtifactPort = (artifactDirectory: string) =>
  Layer.effect(MissionRetroReportArtifactPort, makePort(artifactDirectory));
