// @effect-diagnostics nodeBuiltinImport:off
import {
  PROVIDER_INSTRUCTIONS_MAX_BYTES,
  ProviderInstructionsConflictError,
  ProviderInstructionsError,
  type ProviderInstructionsReadInput,
  type ProviderInstructionsReadResult,
  type ProviderInstructionsWriteInput,
  type ProviderInstructionsWriteResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const AGENTS_IMPORT = "@AGENTS.md\n";

type Failure = ProviderInstructionsError["failure"];

/** Thrown inside the IO helpers so one catch maps it to the contract error. */
class InstructionsFailure extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failure);
    this.failure = failure;
  }
}

const isErrno = (error: unknown, code: string) =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/** Saves never overlap, so the revision check and the replace cannot interleave across connections. */
let saveQueue: Promise<unknown> = Promise.resolve();
const serializeSave = <A>(save: () => Promise<A>): Promise<A> => {
  const next = saveQueue.then(save, save);
  saveQueue = next.catch(() => undefined);
  return next;
};

/** Names the path, so a save after the provider's directory changed conflicts, and the inode, which every save replaces, so coarse mtimes cannot hide an edit. */
const revisionOf = (filePath: string, stat: NodeFS.Stats | null) =>
  stat === null ? `${filePath}|missing` : `${filePath}|${stat.size}:${stat.mtimeMs}:${stat.ino}`;

export class ProviderInstructions extends Context.Service<
  ProviderInstructions,
  {
    readonly read: (
      input: ProviderInstructionsReadInput,
    ) => Effect.Effect<ProviderInstructionsReadResult, ProviderInstructionsError>;
    readonly write: (
      input: ProviderInstructionsWriteInput,
    ) => Effect.Effect<
      ProviderInstructionsWriteResult,
      ProviderInstructionsError | ProviderInstructionsConflictError
    >;
  }
>()("t3/provider/ProviderInstructions") {}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const path = yield* Path.Path;

  const resolveTarget = Effect.fn("ProviderInstructions.resolveTarget")(function* (
    input: ProviderInstructionsReadInput,
  ) {
    const instance = yield* registry.getInstance(input.instanceId);
    if (instance === undefined) {
      return yield* new ProviderInstructionsError({ failure: "provider_not_found" });
    }
    const fileName = instance.instructions?.fileName ?? "AGENTS.md";
    if (input.projectId === undefined) {
      const directory = instance.instructions?.globalDirectory;
      if (directory === undefined) {
        return yield* new ProviderInstructionsError({ failure: "global_unsupported" });
      }
      return { fileName, directory, workspaceRoot: null };
    }
    const project = yield* projectStore
      .get(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ProviderInstructionsError({ failure: "operation_failed", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new ProviderInstructionsError({ failure: "project_not_found" });
    }
    const workspaceRoot = path.resolve(project.value.workspaceRoot);
    return { fileName, directory: workspaceRoot, workspaceRoot };
  });

  /** Follows a symlinked file so a write lands on its target; a link out of the project is refused. */
  const resolveFile = async (target: {
    readonly fileName: string;
    readonly directory: string;
    readonly workspaceRoot: string | null;
  }) => {
    const named = path.join(target.directory, target.fileName);
    let real: string | null;
    try {
      real = await NodeFSP.realpath(named);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      // A dangling link would make a write create its target somewhere unchecked.
      const dangling = await NodeFSP.lstat(named).then(
        () => true,
        (cause: unknown) => {
          if (!isErrno(cause, "ENOENT")) throw cause;
          return false;
        },
      );
      if (dangling) throw new InstructionsFailure("not_file");
      real = null;
    }
    if (real !== null && target.workspaceRoot !== null) {
      const root = await NodeFSP.realpath(target.workspaceRoot);
      const relative = path.relative(root, real);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new InstructionsFailure("outside_workspace");
      }
    }
    return { named, real };
  };

  const statRegularFile = async (handle: NodeFSP.FileHandle) => {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InstructionsFailure("not_file");
    return stat;
  };

  /** Non-blocking so a FIFO fails the regular-file check instead of hanging the open. */
  const openForRead = (filePath: string) =>
    NodeFSP.open(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NONBLOCK ?? 0) |
        // The path was just resolved, so a link swapped in afterwards is refused, not followed.
        (NodeFS.constants.O_NOFOLLOW ?? 0),
    );

  const readFile = async (
    target: Parameters<typeof resolveFile>[0],
  ): Promise<Omit<ProviderInstructionsReadResult, "fileName" | "path">> => {
    const { named, real } = await resolveFile(target);
    if (real === null) {
      const siblingImport =
        target.fileName === "CLAUDE.md" &&
        (await NodeFSP.stat(path.join(target.directory, "AGENTS.md")).then(
          (stat) => stat.isFile(),
          () => false,
        ));
      return {
        contents: siblingImport ? AGENTS_IMPORT : "",
        revision: revisionOf(named, null),
        state: "missing",
      };
    }
    const handle = await openForRead(real);
    try {
      const stat = await statRegularFile(handle);
      const revision = revisionOf(real, stat);
      if (stat.size > PROVIDER_INSTRUCTIONS_MAX_BYTES) {
        return { contents: "", revision, state: "too_large" };
      }
      const buffer = Buffer.allocUnsafe(stat.size);
      let bytesRead = 0;
      while (bytesRead < stat.size) {
        const chunk = await handle.read(buffer, bytesRead, stat.size - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      const bytes = buffer.subarray(0, bytesRead);
      // Lossy decoding would rewrite the bytes it cannot read on the next save.
      const contents = bytes.includes(0) ? null : decodeUtf8(bytes);
      return contents === null
        ? { contents: "", revision, state: "binary" }
        : { contents, revision, state: "ready" };
    } finally {
      await handle.close();
    }
  };

  const writeFile = async (
    target: Parameters<typeof resolveFile>[0],
    contents: string,
    expectedRevision: string,
  ) => {
    if (Buffer.byteLength(contents, "utf8") > PROVIDER_INSTRUCTIONS_MAX_BYTES) {
      throw new InstructionsFailure("too_large");
    }
    if (contents.includes("\0")) throw new InstructionsFailure("binary");
    const { named, real } = await resolveFile(target);
    const currentStat = real === null ? null : await NodeFSP.stat(real);
    if (currentStat !== null && !currentStat.isFile()) throw new InstructionsFailure("not_file");
    const currentRevision = revisionOf(real ?? named, currentStat);
    if (currentRevision !== expectedRevision) return null;

    const destination = real ?? named;
    await NodeFSP.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      // An edit stays private until it has the file's own mode; a new file gets the umask's default.
      await NodeFSP.writeFile(temporary, contents, {
        flag: "wx",
        mode: currentStat === null ? 0o666 : 0o600,
      });
      if (currentStat !== null) await NodeFSP.chmod(temporary, currentStat.mode & 0o777);
      await NodeFSP.rename(temporary, destination);
    } catch (error) {
      await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    // Later reads resolve links, so the revision names the resolved path.
    const resolved = await NodeFSP.realpath(destination);
    const written = await NodeFSP.stat(resolved);
    return { revision: revisionOf(resolved, written), byteLength: written.size };
  };

  const failureFor = (cause: unknown) =>
    new ProviderInstructionsError({
      failure: cause instanceof InstructionsFailure ? cause.failure : "operation_failed",
      ...(cause instanceof InstructionsFailure ? {} : { cause }),
    });

  const read: ProviderInstructions["Service"]["read"] = Effect.fn("ProviderInstructions.read")(
    function* (input) {
      const target = yield* resolveTarget(input);
      const file = yield* Effect.tryPromise({
        try: () => readFile(target),
        catch: failureFor,
      });
      return {
        fileName: target.fileName,
        path: path.join(target.directory, target.fileName),
        ...file,
      };
    },
  );

  const write: ProviderInstructions["Service"]["write"] = Effect.fn("ProviderInstructions.write")(
    function* (input) {
      const target = yield* resolveTarget(input);
      const result = yield* Effect.tryPromise({
        try: () => serializeSave(() => writeFile(target, input.contents, input.revision)),
        catch: failureFor,
      });
      if (result === null) return yield* new ProviderInstructionsConflictError();
      return result;
    },
  );

  return ProviderInstructions.of({ read, write });
});

export const layer = Layer.effect(ProviderInstructions, make);
