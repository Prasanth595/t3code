import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * Rift v0.0.13 through its `rift rpc` JSON protocol. Rift snapshots a
 * registered source into an independent Git repository; T3 records one
 * receipt per destination it created and only ever removes those.
 */
export interface RiftWorktreesOptions {
  readonly executable?: string;
  /** Rift registry. Omitted uses Rift's default registry, where `rift init` registers projects. */
  readonly database?: string;
}

const RiftReceipt = Schema.Struct({
  sourceRoot: Schema.String,
  destination: Schema.String,
  riftId: Schema.String,
});
export type RiftReceipt = typeof RiftReceipt.Type;

export interface RiftChild {
  readonly path: string;
  readonly branch: string | null;
}

const RiftResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), value: Schema.Unknown }),
  Schema.Struct({
    status: Schema.Literal("error"),
    error: Schema.Struct({ code: Schema.String }),
  }),
]);
const decodeRiftResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RiftResponse));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(RiftReceipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(RiftReceipt));
const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const RiftPath = Schema.String;
const RiftPaths = Schema.Array(Schema.String);

const RIFT_ID_PATTERN = /^[0-9A-Z]{26}$/;
const RIFT_CODE_PATTERN = /^[a-z_]{1,40}$/;
const RIFT_CREATE_TIMEOUT_MS = 300_000;
const RIFT_REMOVE_TIMEOUT_MS = 300_000;
const RIFT_QUERY_TIMEOUT_MS = 30_000;

const NOT_INITIALIZED = "Rift could not initialize this project. Try creating the worktree again.";
const FAILURE_DETAILS: Readonly<Record<string, string>> = {
  workspace_not_initialized: NOT_INITIALIZED,
  initialization_required: NOT_INITIALIZED,
  missing_marker:
    "The project's Rift marker is missing. Try creating the worktree again to restore it.",
  cow_unavailable:
    "The worktree location cannot hold copy-on-write clones of this project. Use a worktree location on the same APFS, Btrfs, or XFS volume as the project, or switch Settings → Storage → Worktree backend to Git.",
  unsafe_git:
    "The project has a Git operation in progress, such as a merge or rebase. Finish it, then try again.",
  already_exists: "A folder already exists at the new worktree's path.",
  inside_source:
    "The worktree location is inside a Rift workspace. Choose a location outside the project.",
  invalid_path: "Rift cannot use this worktree path. Folder names cannot start with a dot.",
  database: "Rift could not open its registry on this machine.",
  not_managed: "Rift does not manage this folder.",
  marker_mismatch: "The folder's Rift marker does not match Rift's registry.",
};

export const RIFT_REMOVED_WORKSPACE_OPERATION = "GitVcsDriver.createWorktree.removedRiftWorkspace";

const isGitCommandError = Schema.is(GitCommandError);

export const isRemovedRiftWorkspaceError = (error: unknown): error is GitCommandError =>
  isGitCommandError(error) && error.operation === RIFT_REMOVED_WORKSPACE_OPERATION;

const RECEIPTS_DIRECTORY = "rift-worktrees";

const receiptFileFor = Effect.fn("RiftWorktrees.receiptFileFor")(function* (destination: string) {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(destination)).pipe(
    Effect.mapError(
      (cause) =>
        new GitCommandError({
          operation: "RiftWorktrees.receipt",
          command: "rift",
          cwd: destination,
          detail: "Could not name the Rift receipt.",
          cause,
        }),
    ),
  );
  return path.join(stateDir, RECEIPTS_DIRECTORY, `${Hex.encode(digest)}.json`);
});

/** Whether T3 created the Rift workspace at exactly this canonical path and it is still that workspace. */
export const isOwnedRiftWorkspace = Effect.fn("RiftWorktrees.isOwnedRiftWorkspace")(function* (
  canonicalPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const receipt = yield* receiptFileFor(canonicalPath).pipe(
    Effect.flatMap((file) => fileSystem.readFileString(file)),
    Effect.flatMap(decodeReceipt),
    Effect.orElseSucceed(() => null),
  );
  if (receipt === null || receipt.destination !== canonicalPath) return false;
  const marker = yield* fileSystem
    .readFileString(path.join(canonicalPath, ".rift"))
    .pipe(Effect.orElseSucceed(() => ""));
  return marker.trim() === receipt.riftId;
});

export const makeRiftWorktrees = Effect.fn("makeRiftWorktrees")(function* (
  options: RiftWorktreesOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.make();
  const initializationLock = yield* Semaphore.make(1);
  const executable = options.executable ?? "rift";
  const receiptsDir = path.join(config.stateDir, RECEIPTS_DIRECTORY);

  const rpc = <S extends Schema.Top>(
    operation: string,
    cwd: string,
    request: Readonly<Record<string, unknown>>,
    value: S,
    timeoutMs: number,
  ) =>
    Effect.gen(function* () {
      const output = yield* runner
        .run({
          command: executable,
          args: ["rpc"],
          cwd,
          stdin: encodeRequest({
            ...(options.database === undefined ? {} : { database: options.database }),
            ...request,
          }),
          timeout: timeoutMs,
          maxOutputBytes: 1_000_000,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new GitCommandError({
                operation,
                command: "rift",
                cwd,
                detail:
                  error._tag === "ProcessSpawnError"
                    ? "Rift is not installed on this machine. Install Rift v0.0.13 so `rift` is on the server's PATH, or switch Settings → Storage → Worktree backend to Git."
                    : error._tag === "ProcessTimeoutError"
                      ? "Rift did not finish in time."
                      : "Rift did not respond.",
                cause: error,
              }),
          ),
        );
      const response = yield* decodeRiftResponse(output.stdout.trim()).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation,
              command: "rift",
              cwd,
              detail: "Rift returned an unexpected response. T3 Code supports Rift v0.0.13.",
              cause,
            }),
        ),
      );
      if (response.status === "error") {
        const code = RIFT_CODE_PATTERN.test(response.error.code) ? response.error.code : "unknown";
        return yield* new GitCommandError({
          operation,
          command: "rift",
          cwd,
          detail: FAILURE_DETAILS[code] ?? `Rift ${String(request.command)} failed (${code}).`,
          cause: response.error,
        });
      }
      return yield* Schema.decodeUnknownEffect(value)(response.value).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation,
              command: "rift",
              cwd,
              detail: "Rift returned an unexpected response. T3 Code supports Rift v0.0.13.",
              cause,
            }),
        ),
      );
    });

  const canonicalizeExistingPathOrParent = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() =>
        fileSystem.realPath(path.dirname(target)).pipe(
          Effect.map((parent) => path.join(parent, path.basename(target))),
          Effect.orElseSucceed(() => path.resolve(target)),
        ),
      ),
    );

  const receiptFile = (destination: string) =>
    receiptFileFor(destination).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, config),
    );

  const receipts = yield* Effect.cached(
    Effect.gen(function* () {
      const index = new Map<string, RiftReceipt>();
      const names = yield* fileSystem
        .readDirectory(receiptsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const receipt = yield* fileSystem.readFileString(path.join(receiptsDir, name)).pipe(
          Effect.flatMap(decodeReceipt),
          Effect.orElseSucceed(() => null),
        );
        if (receipt === null) {
          yield* Effect.logWarning("ignoring an unreadable Rift receipt", { name });
          continue;
        }
        index.set(receipt.destination, receipt);
      }
      return index;
    }),
  );

  const writeReceipt = Effect.fn("RiftWorktrees.writeReceipt")(function* (receipt: RiftReceipt) {
    const index = yield* receipts;
    const file = yield* receiptFile(receipt.destination);
    const temporary = `${file}.${receipt.riftId}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(receiptsDir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, encodeReceipt(receipt));
      yield* fileSystem.rename(temporary, file);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "RiftWorktrees.writeReceipt",
            command: "rift",
            cwd: receipt.destination,
            detail: "Could not record the new Rift workspace.",
            cause,
          }),
      ),
    );
    index.set(receipt.destination, receipt);
  });

  const receiptAt = Effect.fn("RiftWorktrees.receiptAt")(function* (target: string) {
    const index = yield* receipts;
    return index.get(yield* canonicalizeExistingPathOrParent(target)) ?? null;
  });

  const readMarker = (directory: string) =>
    fileSystem.readFileString(path.join(directory, ".rift")).pipe(
      Effect.map((contents) => contents.trim()),
      Effect.orElseSucceed(() => ""),
    );

  const readBranch = (directory: string) =>
    fileSystem.readFileString(path.join(directory, ".git", "HEAD")).pipe(
      Effect.map((head) => {
        const match = /^ref: refs\/heads\/(.+)$/.exec(head.trim());
        return match?.[1] ?? null;
      }),
      Effect.orElseSucceed(() => null),
    );

  /** Whether the receipt's workspace is gone, still ours, or replaced by another folder. */
  const inspect = Effect.fn("RiftWorktrees.inspect")(function* (receipt: RiftReceipt) {
    if (!(yield* fileSystem.exists(receipt.destination).pipe(Effect.orElseSucceed(() => true))))
      return "missing" as const;
    return (yield* readMarker(receipt.destination)) === receipt.riftId
      ? ("owned" as const)
      : ("replaced" as const);
  });

  /** Children of `sourceRoot` that T3 created and that still exist, with their checked-out branch. */
  const ownedChildren = Effect.fn("RiftWorktrees.ownedChildren")(function* (sourceRoot: string) {
    const index = yield* receipts;
    const owned = [...index.values()].filter((receipt) => receipt.sourceRoot === sourceRoot);
    if (owned.length === 0) return [];
    const children = yield* Effect.forEach(
      owned,
      (receipt) =>
        readMarker(receipt.destination).pipe(
          Effect.flatMap((marker) =>
            marker === receipt.riftId
              ? readBranch(receipt.destination).pipe(
                  Effect.map((branch): RiftChild | null => ({ path: receipt.destination, branch })),
                )
              : Effect.succeed(null),
          ),
        ),
      { concurrency: 8 },
    );
    return children.filter((child) => child !== null);
  });

  /**
   * Snapshots `sourceRoot` into `destination`. Uninterruptible from the RPC
   * through the receipt and `onClaimed`, so a cancel cannot orphan a copy
   * nobody owns; the RPC itself still honors its timeout. A copy that cannot
   * be verified as ours is left in place rather than guessed and deleted.
   */
  const create = Effect.fn("RiftWorktrees.create")(function* (input: {
    readonly sourceRoot: string;
    readonly destination: string;
    readonly onClaimed?: ((path: string) => Effect.Effect<void, never>) | undefined;
  }) {
    const operation = "GitVcsDriver.createWorktree.rift";
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const created = yield* Effect.forkDetach(
          Effect.interruptible(
            Effect.gen(function* () {
              // Rift registration spans marker and registry writes, so first-use requests must not race.
              yield* initializationLock.withPermit(
                rpc(
                  `${operation}.init`,
                  input.sourceRoot,
                  { command: "init", at: input.sourceRoot },
                  Schema.Null,
                  RIFT_CREATE_TIMEOUT_MS,
                ),
              );
              return yield* rpc(
                operation,
                input.sourceRoot,
                {
                  command: "create",
                  from: input.sourceRoot,
                  into: path.dirname(input.destination),
                  name: path.basename(input.destination),
                  hooks: false,
                },
                RiftPath,
                RIFT_CREATE_TIMEOUT_MS,
              );
            }),
          ),
        ).pipe(Effect.flatMap(Fiber.join));
        if (created !== input.destination) {
          return yield* new GitCommandError({
            operation,
            command: "rift",
            cwd: input.sourceRoot,
            detail: `Rift returned an unexpected workspace path. Check ${input.destination} and Rift's workspace list before trying again; no workspace was removed.`,
          });
        }
        const riftId = yield* readMarker(input.destination);
        const ancestors = yield* rpc(
          operation,
          input.sourceRoot,
          { command: "ancestors", of: input.destination },
          RiftPaths,
          RIFT_QUERY_TIMEOUT_MS,
        );
        if (!RIFT_ID_PATTERN.test(riftId) || ancestors[0] !== input.sourceRoot) {
          return yield* new GitCommandError({
            operation,
            command: "rift",
            cwd: input.sourceRoot,
            detail: `Rift's new workspace could not be verified; it was left at ${input.destination}.`,
          });
        }
        const receipt: RiftReceipt = {
          sourceRoot: input.sourceRoot,
          destination: input.destination,
          riftId,
        };
        yield* writeReceipt(receipt);
        if (input.onClaimed) yield* input.onClaimed(input.destination);
        return receipt;
      }),
    );
  });

  /**
   * Trashes an owned leaf workspace. Rift's RPC remove has no root guard and
   * trashes whole subtrees, so require the exact owned path, its marker, its
   * registered parent, and no children first. A missing path is already gone.
   */
  const trash = Effect.fn("RiftWorktrees.trash")(function* (receipt: RiftReceipt) {
    const operation = "GitVcsDriver.removeWorktree.rift";
    if (!(yield* fileSystem.exists(receipt.destination).pipe(Effect.orElseSucceed(() => true))))
      return;
    if ((yield* canonicalizeExistingPathOrParent(receipt.destination)) !== receipt.destination) {
      return yield* new GitCommandError({
        operation,
        command: "rift",
        cwd: receipt.destination,
        detail: "The Rift workspace path now points somewhere else; it was not removed.",
      });
    }
    if ((yield* readMarker(receipt.destination)) !== receipt.riftId) {
      return yield* new GitCommandError({
        operation,
        command: "rift",
        cwd: receipt.destination,
        detail: "The folder is no longer the Rift workspace T3 Code created.",
      });
    }
    const [ancestors, children] = yield* Effect.all([
      rpc(
        operation,
        receipt.destination,
        { command: "ancestors", of: receipt.destination },
        RiftPaths,
        RIFT_QUERY_TIMEOUT_MS,
      ),
      rpc(
        operation,
        receipt.destination,
        { command: "list", of: receipt.destination },
        RiftPaths,
        RIFT_QUERY_TIMEOUT_MS,
      ),
    ]);
    if (ancestors[0] !== receipt.sourceRoot) {
      return yield* new GitCommandError({
        operation,
        command: "rift",
        cwd: receipt.destination,
        detail: "Rift no longer lists this workspace under its project.",
      });
    }
    if (children.length > 0) {
      return yield* new GitCommandError({
        operation,
        command: "rift",
        cwd: receipt.destination,
        detail: "This Rift workspace has its own Rift copies. Remove them first.",
      });
    }
    yield* rpc(
      operation,
      receipt.destination,
      { command: "remove", at: receipt.destination, hooks: false },
      Schema.Null,
      RIFT_REMOVE_TIMEOUT_MS,
    );
  });

  return { create, trash, receiptAt, inspect, ownedChildren };
});

export type RiftWorktrees = Effect.Success<ReturnType<typeof makeRiftWorktrees>>;
