import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";

/**
 * On macOS, open() of a file or directory under privacy protection waits on a consent prompt
 * a headless server never gets, and an online-only file waits on its download. Either pins a
 * libuv pool thread that interruption cannot free, so there a child the runner kills at the
 * deadline does the open(). Elsewhere stat already rules out the paths whose open() blocks.
 */
const READ_DEADLINE = "2 seconds";
const MAX_READ_BYTES = 1024 * 1024;
// A blocked path is skipped for a while, then read again in case it was fixed.
const BLOCKED_PATH_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED_PATHS = 1024;

export class ProjectFileReader extends Context.Service<
  ProjectFileReader,
  {
    /**
     * Reads a project file without risking the libuv pool. Undefined when it is missing, not a
     * regular file, over 1 MiB, unreadable, or its open() outlived the deadline.
     */
    readonly readFileString: (filePath: string) => Effect.Effect<string | undefined>;
    /** Lists a project directory's entry names, with the same guarantees as readFileString. */
    readonly readDirectory: (directory: string) => Effect.Effect<ReadonlyArray<string> | undefined>;
  }
>()("t3/project/ProjectFileReader") {}

/** Whether candidate lies in one of the project's directories, so it is read with the reader. */
export function isProjectPath(
  path: Path.Path,
  projectDirectories: ReadonlyArray<string | null | undefined>,
  candidate: string,
): boolean {
  return projectDirectories.some((directory) => {
    if (directory === null || directory === undefined) return false;
    const relative = path.relative(path.resolve(directory), path.resolve(candidate));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

/** @public */
export const make = Effect.fn("ProjectFileReader.make")(function* (
  // Absolute, so a broken PATH cannot quietly turn every read into a miss.
  binaries: { readonly cat: string; readonly find: string } = {
    cat: "/bin/cat",
    find: "/usr/bin/find",
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const isDarwin = (yield* HostProcess.Platform) === "darwin";
  // Paths whose read outlived the deadline, mapped to when they may be read again, so later
  // turn starts do not each wait the deadline out.
  const blockedPaths = new Map<string, number>();

  const readInChild = Effect.fnUntraced(function* (
    target: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if ((blockedPaths.get(target) ?? 0) > now) return undefined;
    blockedPaths.delete(target);
    const result = yield* processRunner
      .run({
        command,
        args,
        timeout: READ_DEADLINE,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_READ_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.tapErrorTag("ProcessSpawnError", (cause) =>
          Effect.logWarning("could not start a project file read", { path: target, cause }),
        ),
        Effect.option,
      );
    if (Option.isNone(result)) return undefined;
    if (result.value.timedOut) {
      if (blockedPaths.size >= MAX_BLOCKED_PATHS) {
        blockedPaths.delete(blockedPaths.keys().next().value!);
      }
      blockedPaths.set(target, now + BLOCKED_PATH_RETRY_MS);
      yield* Effect.logWarning("project file read timed out; skipping it for a while", {
        path: target,
      });
      return undefined;
    }
    if (result.value.stdoutTruncated) {
      yield* Effect.logWarning("project file read exceeded 1 MiB; ignoring it", { path: target });
      return undefined;
    }
    return result.value.code === 0 ? result.value.stdout : undefined;
  });

  // stat does not open the path, so it neither blocks nor costs a spawn for missing paths.
  const statType = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => ({ type: info.type, size: Number(info.size) })),
      Effect.orElseSucceed(() => undefined),
    );

  const readFileString: ProjectFileReader["Service"]["readFileString"] = Effect.fn(
    "ProjectFileReader.readFileString",
  )(function* (filePath) {
    const info = yield* statType(filePath);
    if (info?.type !== "File") return undefined;
    if (info.size > MAX_READ_BYTES) {
      yield* Effect.logWarning("project file exceeds 1 MiB; ignoring it", { path: filePath });
      return undefined;
    }
    if (!isDarwin) {
      return yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));
    }
    return yield* readInChild(filePath, binaries.cat, ["--", filePath]);
  });

  const readDirectory: ProjectFileReader["Service"]["readDirectory"] = Effect.fn(
    "ProjectFileReader.readDirectory",
  )(function* (directory) {
    if ((yield* statType(directory))?.type !== "Directory") return undefined;
    if (!isDarwin) {
      return yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => undefined));
    }
    // find has no `--`, so a relative path must not start with a dash. NUL-separated because
    // entry names may contain newlines. -H follows a symlinked start directory, as readdir does.
    const start = directory.startsWith("/") ? directory : `./${directory}`;
    const output = yield* readInChild(directory, binaries.find, [
      "-H",
      start,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-print0",
    ]);
    return output
      ?.split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(entry.lastIndexOf("/") + 1));
  });

  return ProjectFileReader.of({ readFileString, readDirectory });
});

export const layer = Layer.effect(ProjectFileReader, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
