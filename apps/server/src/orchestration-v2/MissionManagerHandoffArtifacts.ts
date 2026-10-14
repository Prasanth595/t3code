// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds exact canonical handoff bytes; link-based commit keeps files immutable.
import * as NodeCrypto from "node:crypto";
import * as NodeConstants from "node:constants";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { MANAGER_HANDOFF_ARTIFACT_NAMESPACE } from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  HANDOFF_MAX_SERIALIZED_BYTES,
  HANDOFF_SNAPSHOT_SCHEMA_VERSION,
  buildManagerHandoffSnapshot,
  type BuildManagerHandoffInput,
  type ManagerHandoffSnapshot,
} from "./MissionManagerHandoff.ts";
import {
  MAX_HANDOFF_ARTIFACT_BYTES,
  MissionManagerHandoffArtifactPort,
  MissionManagerTransferStoreError,
} from "./MissionManagerTransferStore.ts";

/**
 * Private filesystem source backing for the accepted
 * `MissionManagerHandoffArtifactPort` (P3 handoff slice).
 *
 * Layout: `<artifactDirectory>/manager-handoff/<sha>.json`. Files are
 * private (`0600`) under a private root (`0700`). Commits are immutable:
 * only the exact bytes returned by the accepted `buildManagerHandoffSnapshot`
 * builder are persisted, written to an exclusive temp file and hard-linked
 * into place, so concurrent retries reuse matching bytes and conflicting
 * bytes fail closed without touching the accepted file. Symlink destinations
 * and escapes are rejected; refs never address arbitrary paths.
 *
 * There is no public method accepting arbitrary raw snapshot bytes: the
 * root/internal stage entry takes a `BuildManagerHandoffInput`, runs the
 * accepted builder itself, and persists only its exact returned bytes. The
 * root store stays the validation gate; this layer never authorizes roles,
 * reads live mission state, or synthesizes metadata from caller claims.
 * File contents are authorized non-secret pointer metadata only; source
 * wording is already hash/reference via the builder.
 */

/** Byte bound for one complete canonical handoff snapshot; over-bound input is rejected, never truncated. */
export const MAX_MANAGER_HANDOFF_ARTIFACT_BYTES = MAX_HANDOFF_ARTIFACT_BYTES;

const REF_PATTERN = new RegExp(`^${MANAGER_HANDOFF_ARTIFACT_NAMESPACE}:([0-9a-f]{64})$`);

type StoreErrorCategory = MissionManagerTransferStoreError["category"];

const storeError = (
  category: StoreErrorCategory,
  cause?: unknown,
): MissionManagerTransferStoreError =>
  cause === undefined
    ? new MissionManagerTransferStoreError({ operation: "reserve", category })
    : new MissionManagerTransferStoreError({ operation: "reserve", category, cause });

const sha256Hex = (bytes: NodeJS.TypedArray): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Strict canonical ref for the single namespace, or null. Rejects traversal, wrong types, and non-hex SHAs. */
export const parseManagerHandoffRef = (ref: string): string | null =>
  typeof ref === "string" ? (REF_PATTERN.exec(ref)?.[1] ?? null) : null;

/** Filesystem path for a canonical ref, or null when the ref is not strict. Never resolves caller paths. */
export const artifactPathForRef = (artifactDirectory: string, ref: string): string | null => {
  const sha = parseManagerHandoffRef(ref);
  if (sha === null) return null;
  return NodePath.join(artifactDirectory, MANAGER_HANDOFF_ARTIFACT_NAMESPACE, `${sha}.json`);
};

const checkRoot = (artifactDirectory: string): string | null =>
  typeof artifactDirectory === "string" &&
  artifactDirectory.length > 0 &&
  NodePath.isAbsolute(artifactDirectory)
    ? artifactDirectory
    : null;

const removeQuiet = (path: string): Promise<void> =>
  NodeFSP.unlink(path).then(
    () => undefined,
    () => undefined,
  );

const isMissing = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException)?.code === "ENOENT";

const currentUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/** Insecure when group/other has any access bit, or when owned by another user. */
const isSecureMode = (mode: number, uid: number): boolean =>
  (mode & 0o077) === 0 && (currentUid() === null || uid === currentUid());

const identityOf = (status: { readonly dev: number; readonly ino: number }): string =>
  `${status.dev}:${status.ino}`;

interface ControlledRoot {
  readonly configured: string;
  readonly resolved: string;
  readonly identity: string;
  readonly mode: number;
  readonly uid: number;
}

interface PinnedDirectory {
  readonly path: string;
  readonly identity: string;
  readonly mode: number;
  readonly uid: number;
}

/**
 * Controlled root: the artifact root itself must be a real directory, never
 * a symlink, privately owned. Ancestor aliases (for example macOS
 * `/tmp` -> `/private/tmp`) are legitimate, so the once-resolved real root
 * pins all later joins; callers recheck identity to detect drift.
 */
const resolveControlledRoot = async (root: string, create: boolean): Promise<ControlledRoot> => {
  if (create) {
    await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
  }
  const status = await NodeFSP.lstat(root);
  if (status.isSymbolicLink() || !status.isDirectory() || !isSecureMode(status.mode, status.uid))
    throw new Error("Artifact root is not a private directory.");
  const resolved = await NodeFSP.realpath(root);
  const confirmed = await NodeFSP.lstat(resolved);
  if (
    confirmed.isSymbolicLink() ||
    !confirmed.isDirectory() ||
    !isSecureMode(confirmed.mode, confirmed.uid)
  )
    throw new Error("Artifact root is not a private directory.");
  if (identityOf(confirmed) !== identityOf(status))
    throw new Error("Artifact root is not a private directory.");
  return { configured: root, resolved, identity: identityOf(confirmed), mode: confirmed.mode, uid: confirmed.uid };
};

const ensureNamespace = async (root: ControlledRoot, create: boolean): Promise<PinnedDirectory> => {
  const directory = NodePath.join(root.resolved, MANAGER_HANDOFF_ARTIFACT_NAMESPACE);
  if (create) {
    await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
  }
  const status = await NodeFSP.lstat(directory).catch((cause: unknown) => {
    if (isMissing(cause)) throw new Error("Stored artifact is missing.");
    throw cause;
  });
  if (status.isSymbolicLink() || !status.isDirectory() || !isSecureMode(status.mode, status.uid))
    throw new Error("Stored artifact destination is not a regular file.");
  const resolved = await NodeFSP.realpath(directory);
  if (resolved !== directory) throw new Error("Stored artifact destination is not a regular file.");
  return { path: directory, identity: identityOf(status), mode: status.mode, uid: status.uid };
};

/** Deny when a pinned directory was replaced, re-resolved, or re-permissioned mid-operation. */
const recheckPinnedDirectory = async (pinned: PinnedDirectory, driftMessage: string): Promise<void> => {
  const resolved = await NodeFSP.realpath(pinned.path).catch(() => null);
  if (resolved === null || resolved !== pinned.path) throw new Error(driftMessage);
  const status = await NodeFSP.lstat(resolved);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    identityOf(status) !== pinned.identity ||
    status.mode !== pinned.mode ||
    status.uid !== pinned.uid ||
    !isSecureMode(status.mode, status.uid)
  )
    throw new Error(driftMessage);
};

const recheckRoot = async (root: ControlledRoot): Promise<void> => {
  const configured = await NodeFSP.lstat(root.configured);
  if (configured.isSymbolicLink() || identityOf(configured) !== root.identity ||
      await NodeFSP.realpath(root.configured) !== root.resolved)
    throw new Error("Artifact root identity drifted during the operation.");
  await recheckPinnedDirectory(
    { path: root.resolved, identity: root.identity, mode: root.mode, uid: root.uid },
    "Artifact root identity drifted during the operation.",
  );
};

const recheckNamespace = (namespace: PinnedDirectory): Promise<void> =>
  recheckPinnedDirectory(namespace, "Stored artifact destination is not a regular file.");

interface StoredBytes {
  readonly reused: boolean;
}

/**
 * One bounded, no-follow, exact read used by every reuse, raced-commit, and
 * port read path. The size bound is enforced from the opened handle before
 * any bytes are consumed; leaf inode, size, mode, and owner are re-verified
 * after the read, and the destination must still resolve to itself. Returns
 * a fresh owned buffer.
 */
const readExactBounded = async (destination: string): Promise<Buffer> => {
  const status = await NodeFSP.lstat(destination).catch((cause: unknown) =>
    isMissing(cause) ? null : Promise.reject(cause),
  );
  if (status === null) throw new Error("Stored artifact is missing.");
  if (status.isSymbolicLink() || !status.isFile() || !isSecureMode(status.mode, status.uid))
    throw new Error("Stored artifact destination is not a regular file.");
  const handle = await NodeFSP.open(destination, NodeConstants.O_RDONLY | NodeConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !isSecureMode(opened.mode, opened.uid))
      throw new Error("Stored artifact destination is not a regular file.");
    if (identityOf(opened) !== identityOf(status) || opened.size !== status.size)
      throw new Error("Stored artifact changed during the read.");
    if (opened.size <= 0 || opened.size > MAX_MANAGER_HANDOFF_ARTIFACT_BYTES)
      throw new Error("Stored artifact exceeds its byte bound.");
    // A file may grow after fstat; never let readFile allocate its new size.
    const bounded = Buffer.alloc(MAX_MANAGER_HANDOFF_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const read = await handle.read(bounded, length, bounded.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const bytes = bounded.subarray(0, length);
    if (bytes.length !== opened.size || bytes.length > MAX_MANAGER_HANDOFF_ARTIFACT_BYTES)
      throw new Error("Stored artifact exceeds its byte bound.");
    const after = await handle.stat();
    if (
      !after.isFile() ||
      identityOf(after) !== identityOf(opened) ||
      after.size !== opened.size ||
      after.mode !== opened.mode ||
      after.uid !== opened.uid
    )
      throw new Error("Stored artifact changed during the read.");
    const realDestination = await NodeFSP.realpath(destination);
    if (realDestination !== destination) throw new Error("Stored artifact is missing.");
    const leaf = await NodeFSP.lstat(destination).catch((cause: unknown) =>
      isMissing(cause) ? null : Promise.reject(cause),
    );
    if (
      leaf === null ||
      leaf.isSymbolicLink() ||
      !leaf.isFile() ||
      identityOf(leaf) !== identityOf(opened) ||
      leaf.size !== opened.size ||
      leaf.mode !== opened.mode ||
      leaf.uid !== opened.uid
    )
      throw new Error("Stored artifact changed during the read.");
    return Buffer.from(bytes);
  } finally {
    await handle.close();
  }
};

/**
 * Immutable content-addressed commit of exact builder bytes. An existing
 * matching file is reused; existing differing bytes fail closed without
 * overwriting the accepted file. The link into place is atomic, so parallel
 * retries cannot truncate or partially overwrite. Symlink destinations are
 * rejected, never followed. Only uniquely owned temp files are cleaned up;
 * the accepted file is never deleted.
 */
const commitExactBytesAsync = async (input: {
  readonly artifactDirectory: string;
  readonly sha: string;
  readonly bytes: Buffer;
}): Promise<StoredBytes> => {
  const root = await resolveControlledRoot(input.artifactDirectory, true);
  const namespace = await ensureNamespace(root, true);
  const directory = namespace.path;
  const destination = NodePath.join(directory, `${input.sha}.json`);
  const existing = await NodeFSP.lstat(destination).catch((cause: unknown) =>
    isMissing(cause) ? null : Promise.reject(cause),
  );
  if (existing !== null) {
    const current = await readExactBounded(destination);
    if (Buffer.compare(current, input.bytes) !== 0)
      throw new Error("Stored artifact bytes do not match the content address.");
    // A previous or concurrent writer may have linked without completing its
    // directory sync. A retry must establish durability before reporting reuse.
    await syncDirectory(directory);
    await recheckNamespace(namespace);
    await recheckRoot(root);
    return { reused: true };
  }
  const temporary = NodePath.join(directory, `.tmp-${NodeCrypto.randomUUID()}`);
  let tempIdentity: string | null = null;
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
      const tempStat = await handle.stat();
      if (!tempStat.isFile() || tempStat.size !== input.bytes.length)
        throw new Error("Stored artifact changed during the write.");
      tempIdentity = identityOf(tempStat);
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
      const current = await readExactBounded(destination);
      if (Buffer.compare(current, input.bytes) !== 0)
        throw new Error("Stored artifact bytes do not match the content address.");
      await syncDirectory(directory);
      await recheckNamespace(namespace);
      await recheckRoot(root);
      return { reused: true };
    }
    // The committed destination must be the exact temporary inode just
    // written, holding the exact builder bytes, before success is reported.
    const committed = await NodeFSP.lstat(destination);
    if (
      committed.isSymbolicLink() ||
      !committed.isFile() ||
      !isSecureMode(committed.mode, committed.uid) ||
      identityOf(committed) !== tempIdentity ||
      committed.size !== input.bytes.length
    )
      throw new Error("Stored artifact changed during the commit.");
    const committedBytes = await readExactBounded(destination);
    if (Buffer.compare(committedBytes, input.bytes) !== 0 || sha256Hex(committedBytes) !== input.sha)
      throw new Error("Stored artifact bytes do not match the content address.");
    await syncDirectory(directory);
    await recheckNamespace(namespace);
    await recheckRoot(root);
    return { reused: false };
  } finally {
    // Remove only the uniquely owned temp file, and only while it is still
    // the captured inode inside the unchanged namespace; a replacement at
    // the temp path or a drifted namespace is left untouched. The accepted
    // destination is never deleted, even on failure.
    if (tempIdentity !== null) {
      const nsNow = await NodeFSP.lstat(directory).catch(() => null);
      if (nsNow !== null && identityOf(nsNow) === namespace.identity) {
        const tempNow = await NodeFSP.lstat(temporary).catch(() => null);
        if (tempNow !== null && identityOf(tempNow) === tempIdentity)
          await removeQuiet(temporary);
      }
    }
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export interface ManagerHandoffStagedArtifact {
  readonly artifactRef: string;
  readonly artifactSha: string;
  readonly byteCount: number;
  readonly reused: boolean;
  /** Prepared metadata only: identity/binding pointers, never raw source wording. */
  readonly prepared: {
    readonly schemaVersion: typeof HANDOFF_SNAPSHOT_SCHEMA_VERSION;
    readonly namespace: typeof MANAGER_HANDOFF_ARTIFACT_NAMESPACE;
    readonly missionRef: string;
    readonly missionRevision: number;
    readonly teamId: string;
    readonly environmentId: string;
    readonly role: ManagerHandoffSnapshot["manager"]["role"];
    readonly managerThreadId: string;
    readonly epoch: number;
    readonly timezone: string;
    readonly localDate: string;
    readonly ordinal: number;
    readonly reason: ManagerHandoffSnapshot["boundary"]["reason"];
  };
}

/**
 * Trusted internal preparation: runs the accepted builder on the supplied
 * canonical mission plus prepared rotation intent, denies bounded builder
 * failures, and persists ONLY the exact returned bytes under
 * `manager-handoff:<sha256>`. This is not live authorization and not a
 * current-role read; full canonical current-role/authority validation stays
 * with the store and the later adapter. No raw snapshot bytes accepted.
 */
export const stageManagerHandoffArtifact = Effect.fn("MissionManagerHandoffArtifacts.stage")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly input: BuildManagerHandoffInput;
  }): Effect.fn.Return<ManagerHandoffStagedArtifact, MissionManagerTransferStoreError> {
    if (checkRoot(input.artifactDirectory) === null)
      return yield* storeError(
        "scope_denied",
        new Error("Artifact directory must be absolute."),
      );
    let detached: BuildManagerHandoffInput;
    try {
      detached = structuredClone(input.input);
    } catch (cause) {
      return yield* storeError("request_conflict", cause);
    }
    const built = buildManagerHandoffSnapshot(detached);
    if (built.ok === false)
      return yield* storeError(
        "request_conflict",
        new Error(`Handoff builder rejected the input (${built.reason}).`),
      );
    const bytes = Buffer.from(built.bytes);
    if (bytes.length === 0 || bytes.length > MAX_MANAGER_HANDOFF_ARTIFACT_BYTES)
      return yield* storeError(
        "request_conflict",
        new Error("Handoff bytes exceed their bound."),
      );
    if (built.bytes.length !== bytes.length || sha256Hex(bytes) !== built.sha256Hex)
      return yield* storeError("persistence", new Error("Handoff bytes drifted before commit."));
    if (HANDOFF_MAX_SERIALIZED_BYTES !== MAX_MANAGER_HANDOFF_ARTIFACT_BYTES)
      return yield* storeError("persistence", new Error("Handoff byte bound drifted."));
    const stored = yield* Effect.tryPromise({
      try: () =>
        commitExactBytesAsync({
          artifactDirectory: input.artifactDirectory,
          sha: built.sha256Hex,
          bytes,
        }),
      catch: (cause) => storeError("persistence", cause),
    });
    const snapshot = built.snapshot;
    return Object.freeze({
      artifactRef: `${MANAGER_HANDOFF_ARTIFACT_NAMESPACE}:${built.sha256Hex}`,
      artifactSha: built.sha256Hex,
      byteCount: bytes.length,
      reused: stored.reused,
      prepared: Object.freeze({
        schemaVersion: HANDOFF_SNAPSHOT_SCHEMA_VERSION,
        namespace: MANAGER_HANDOFF_ARTIFACT_NAMESPACE,
        missionRef: snapshot.mission.ref,
        missionRevision: snapshot.mission.revision,
        teamId: snapshot.mission.teamId,
        environmentId: snapshot.mission.environmentId,
        role: snapshot.manager.role,
        managerThreadId: snapshot.manager.threadId,
        epoch: snapshot.manager.epoch,
        timezone: snapshot.boundary.timezone,
        localDate: snapshot.boundary.localDate,
        ordinal: snapshot.boundary.ordinal,
        reason: snapshot.boundary.reason,
      }),
    });
  },
);

export { MissionManagerHandoffArtifactPort, MissionManagerTransferStoreError };

export interface ManagerHandoffReadResult {
  readonly artifactRef: string;
  readonly artifactSha: string;
  /** Alias of `artifactSha`: whole-byte SHA-256 hex bound by the ref. */
  readonly sha256Hex: string;
  readonly byteCount: number;
  readonly snapshotVersion: typeof HANDOFF_SNAPSHOT_SCHEMA_VERSION;
  readonly namespace: typeof MANAGER_HANDOFF_ARTIFACT_NAMESPACE;
  /** Exact stored bytes as text; fresh owned buffer in `bytes`. */
  readonly text: string;
  /** Fresh owned copy; mutating it never affects the stored file. */
  readonly bytes: Uint8Array;
}

/**
 * Exact byte read for one canonical `manager-handoff:<sha256>` ref. The ref
 * hash must equal the whole-byte SHA and the bytes must decode as complete
 * fatal UTF-8. Missing, oversized, non-UTF-8, mismatched, symlinked, or
 * insecurely permissioned files fail closed and are preserved.
 */
export const readManagerHandoffArtifact = Effect.fn("MissionManagerHandoffArtifacts.read")(
  function* (input: {
    readonly artifactDirectory: string;
    readonly ref: string;
  }): Effect.fn.Return<ManagerHandoffReadResult, MissionManagerTransferStoreError> {
    if (checkRoot(input.artifactDirectory) === null)
      return yield* storeError(
        "scope_denied",
        new Error("Artifact directory must be absolute."),
      );
    const refHash = parseManagerHandoffRef(input.ref);
    if (refHash === null)
      return yield* storeError(
        "request_conflict",
        new Error("Artifact ref is not a strict canonical content address."),
      );
    const raw = yield* Effect.tryPromise({
      try: () => readRawAsync({ artifactDirectory: input.artifactDirectory, refHash }),
      catch: (cause) =>
        /strict canonical content address/.test((cause as Error)?.message ?? "")
          ? storeError("request_conflict", cause)
          : storeError("persistence", cause),
    });
    if (raw.sha !== refHash)
      return yield* storeError(
        "persistence",
        new Error("Stored artifact bytes do not match the content address."),
      );
    return {
      artifactRef: input.ref,
      artifactSha: raw.sha,
      sha256Hex: raw.sha,
      byteCount: raw.bytes.length,
      snapshotVersion: HANDOFF_SNAPSHOT_SCHEMA_VERSION,
      namespace: MANAGER_HANDOFF_ARTIFACT_NAMESPACE,
      text: raw.text,
      bytes: new Uint8Array(raw.bytes),
    };
  },
);

interface RawBytes {
  readonly text: string;
  readonly sha: string;
  readonly bytes: Buffer;
}

const readRawAsync = async (input: {
  readonly artifactDirectory: string;
  readonly refHash: string;
}): Promise<RawBytes> => {
  const root = await resolveControlledRoot(input.artifactDirectory, false);
  const namespace = await ensureNamespace(root, false);
  const destination = NodePath.join(namespace.path, `${input.refHash}.json`);
  const bytes = await readExactBounded(destination);
  const sha = sha256Hex(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (Buffer.byteLength(text, "utf8") !== bytes.length)
    throw new Error("Stored artifact is not complete UTF-8.");
  await recheckNamespace(namespace);
  await recheckRoot(root);
  return { text, sha, bytes: Buffer.from(bytes) };
};

/**
 * Filesystem port factory. `artifactDirectory` is explicit and must be
 * absolute; the trusted internal preparation lives in this module (stage
 * runs the accepted builder itself) and the store stays the validation
 * gate. There is deliberately no production adapter yet: without an
 * explicitly supplied root the port refuses every read, and the missing
 * adapter below fails explicitly instead of manufacturing bytes. No global
 * state, startup work, network, or provider calls.
 */
export const makeManagerHandoffArtifactPort = (
  artifactDirectory: string,
): Effect.Effect<
  MissionManagerHandoffArtifactPort["Service"],
  MissionManagerTransferStoreError
> =>
  Effect.gen(function* () {
    if (checkRoot(artifactDirectory) === null)
      return yield* storeError(
        "scope_denied",
        new Error("Artifact directory must be absolute."),
      );
    return MissionManagerHandoffArtifactPort.of({
      readArtifact: (ref: string) =>
        Effect.map(
          readManagerHandoffArtifact({ artifactDirectory, ref }),
          (read) => new Uint8Array(read.bytes),
        ),
    });
  });

/**
 * Placeholder adapter wiring: no production manager-handoff adapter exists
 * yet. Building the filesystem port without an explicitly supplied root is
 * impossible; this layer fails explicitly instead of defaulting to ambient
 * state. The parent supplies the actual production root later.
 */
export const layerMissingHandoffAdapter: Layer.Layer<
  MissionManagerHandoffArtifactPort,
  MissionManagerTransferStoreError
> = Layer.effect(
  MissionManagerHandoffArtifactPort,
  Effect.fail(
    storeError(
      "scope_denied",
      new Error(
        "No production manager-handoff adapter is configured: supply an explicit private artifact root.",
      ),
    ),
  ),
);

/**
 * Filesystem port layer. `artifactDirectory` is explicit and must be
 * absolute (tests use a temp directory). No global state, startup work,
 * network, or provider calls.
 */
export const layerFilesystemManagerHandoffArtifactPort = (artifactDirectory: string) =>
  Layer.effect(MissionManagerHandoffArtifactPort, makeManagerHandoffArtifactPort(artifactDirectory));