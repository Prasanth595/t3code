// @effect-diagnostics nodeBuiltinImport:off -- the graph identity hashes the actual emitted module bytes.
import { createHash } from "node:crypto";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const MANIFEST_FILE_NAME = "mission-peer-bundle.json";
const MAX_MODULES = 256;
export const MAX_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

// The current vp pack output is flat ESM. Nested paths and other output layouts
// need an explicit extension rather than a directory walk or path normalization.
const ModuleName = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.makeFilter((name) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.mjs$/.test(name), {
    expected: "a flat emitted ESM module filename",
  }),
);
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  format: Schema.Literal("t3-mission-peer-esm-graph/v1"),
  entry: Schema.Literal("bin.mjs"),
  modules: Schema.Array(ModuleName).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MODULES),
    Schema.makeFilter(
      (names) =>
        names.includes("bin.mjs") &&
        new Set(names.map((name) => name.toLowerCase())).size === names.length,
      { expected: "unique emitted module names including bin.mjs" },
    ),
  ),
});
type Manifest = typeof Manifest.Type;
const encodeDigestDocument = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Manifest.fields.version,
      format: Manifest.fields.format,
      entry: Manifest.fields.entry,
      modules: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    }),
  ),
);

export class MissionPeerBundleIdentityError extends Schema.TaggedError<MissionPeerBundleIdentityError>()(
  "MissionPeerBundleIdentityError",
  {
    category: Schema.Literals(["layout", "bounds", "read"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission peer bundle identity refused (${this.category}).`;
  }
}

export interface LoadedBundleGraph {
  readonly kind: "esm-module-graph";
  readonly directory: string;
  readonly manifest: Manifest;
  readonly sha256: string;
  readonly receiptId: string;
}

/**
 * Build hook only: pass EVERY output chunk's fileName from generateBundle,
 * including shared chunks, lazy imports, fast paths and the history worker.
 * Record names, not predicted code hashes: the writer may append sourcemap
 * comments after that hook. Runtime always hashes the final installed bytes.
 */
export const makeManifest = (moduleNames: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(Manifest)(
    {
      version: 1,
      format: "t3-mission-peer-esm-graph/v1",
      entry: "bin.mjs",
      modules: [...moduleNames].sort(),
    },
    { onExcessProperty: "error" },
  );

/**
 * Reject symlink aliases and nonfiles before bounded reads. This is validation
 * for an immutable installation, not an atomic defense against a hostile writer
 * replacing files between realPath/stat/open. No directory discovery is used.
 */
export const readBoundedFile = Effect.fn("MissionPeerBundleIdentity.readBoundedFile")(function* (
  filePath: string,
  maxBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const canonical = yield* fs
    .realPath(filePath)
    .pipe(
      Effect.mapError((cause) => new MissionPeerBundleIdentityError({ category: "read", cause })),
    );
  if (canonical !== filePath) {
    return yield* new MissionPeerBundleIdentityError({ category: "layout" });
  }
  const info = yield* fs
    .stat(filePath)
    .pipe(
      Effect.mapError((cause) => new MissionPeerBundleIdentityError({ category: "read", cause })),
    );
  if (info.type !== "File") {
    return yield* new MissionPeerBundleIdentityError({ category: "layout" });
  }
  const size = ByteSize.toBigInt(info.size);
  if (size <= 0n || size > BigInt(maxBytes)) {
    return yield* new MissionPeerBundleIdentityError({ category: "bounds" });
  }
  const initial: { chunks: Uint8Array[]; bytes: number } = { chunks: [], bytes: 0 };
  const result = yield* fs
    .stream(filePath, { bytesToRead: maxBytes + 1, chunkSize: 64 * 1024 })
    .pipe(
      Stream.mapError((cause) => new MissionPeerBundleIdentityError({ category: "read", cause })),
      Stream.runFoldEffect(
        () => initial,
        (state, chunk) => {
          const bytes = state.bytes + chunk.byteLength;
          if (bytes > maxBytes) {
            return Effect.fail(new MissionPeerBundleIdentityError({ category: "bounds" }));
          }
          state.chunks.push(chunk);
          return Effect.succeed({ chunks: state.chunks, bytes });
        },
      ),
    );
  if (BigInt(result.bytes) !== size) {
    return yield* new MissionPeerBundleIdentityError({ category: "read" });
  }
  return Buffer.concat(result.chunks, result.bytes);
});

/**
 * One algorithm for initial capture and EVERY later attestation. Domain/version,
 * entry and sorted [relative filename, actual byte SHA256] pairs determine the
 * graph digest. This covers own emitted ESM only: external native dependencies,
 * their JS wrappers, Node, client assets and runtime configuration are NOT pinned.
 */
export const rehash = Effect.fn("MissionPeerBundleIdentity.rehash")(function* (
  graph: Pick<LoadedBundleGraph, "directory" | "manifest">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(graph.manifest, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new MissionPeerBundleIdentityError({ category: "layout" })));
  const canonicalDirectory = yield* fs
    .realPath(graph.directory)
    .pipe(
      Effect.mapError((cause) => new MissionPeerBundleIdentityError({ category: "read", cause })),
    );
  if (!path.isAbsolute(graph.directory) || canonicalDirectory !== graph.directory) {
    return yield* new MissionPeerBundleIdentityError({ category: "layout" });
  }
  const emittedModules = (yield* fs
    .readDirectory(graph.directory)
    .pipe(
      Effect.mapError((cause) => new MissionPeerBundleIdentityError({ category: "read", cause })),
    ))
    .filter((name) => /\.mjs$/i.test(name))
    .sort();
  const expectedModules = [...manifest.modules].sort();
  if (
    emittedModules.length !== expectedModules.length ||
    emittedModules.some((name, index) => name !== expectedModules[index])
  ) {
    return yield* new MissionPeerBundleIdentityError({ category: "layout" });
  }
  const modules: Array<readonly [string, string]> = [];
  let remainingBytes = MAX_GRAPH_BYTES;
  for (const fileName of [...manifest.modules].sort()) {
    const bytes = yield* readBoundedFile(
      path.join(graph.directory, fileName),
      Math.min(MAX_MODULE_BYTES, remainingBytes),
    );
    remainingBytes -= bytes.byteLength;
    modules.push([fileName, createHash("sha256").update(bytes).digest("hex")]);
  }
  return createHash("sha256")
    .update(
      encodeDigestDocument({
        version: manifest.version,
        format: manifest.format,
        entry: manifest.entry,
        modules,
      }),
    )
    .digest("hex");
});

/**
 * Bootstrap has already bound the canonical owning bin to process argv[1].
 * The build-produced manifest beside that bin defines the complete own module
 * set; the currently executing producer must be one of those exact files.
 * Receiver trust still comes from its reviewed graph-digest pin, not this JSON.
 */
export const capture = Effect.fn("MissionPeerBundleIdentity.capture")(function* (input: {
  readonly entryPath: string;
  readonly producerPath: string;
  readonly bootId: string;
}) {
  const path = yield* Path.Path;
  if (path.basename(input.entryPath) !== "bin.mjs") {
    return yield* new MissionPeerBundleIdentityError({ category: "layout" });
  }
  const directory = path.dirname(input.entryPath);
  const bytes = yield* readBoundedFile(
    path.join(directory, MANIFEST_FILE_NAME),
    MAX_MANIFEST_BYTES,
  );
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => new MissionPeerBundleIdentityError({ category: "layout" }),
  });
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new MissionPeerBundleIdentityError({ category: "layout" })));
  if (!manifest.modules.some((name) => path.join(directory, name) === input.producerPath)) {
    return yield* new MissionPeerBundleIdentityError({ category: "layout" });
  }
  const sha256 = yield* rehash({ directory, manifest });
  return {
    kind: "esm-module-graph" as const,
    directory,
    manifest,
    sha256,
    receiptId: `loaded-graph:${input.bootId}:sha256:${sha256}`,
  } satisfies LoadedBundleGraph;
});
