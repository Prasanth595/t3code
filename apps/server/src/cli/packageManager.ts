import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProcessRunner } from "../processRunner.ts";
import { resolveEntryPath } from "./invocation.ts";

export interface ManagedPackage {
  readonly name: string;
  /** The package installs the command that rebuilds and reinstalls it, when it knows one. */
  readonly rebuildCommand: string | undefined;
}

/**
 * A distro package owns the files it installed, so repointing the launcher
 * (`update`) or deleting the runtime (`uninstall`) would leave the package
 * database lying. `pacman -Qoq` is the only reliable answer, and it exits
 * non-zero on every host that has no pacman.
 */
export const detectManagedPackage = Effect.fn("cli.packageManager.detect")(function* (
  entryPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const entry = yield* fs.realPath(entryPath).pipe(Effect.orElseSucceed(() => entryPath));
  const ownership = yield* runner
    .run({
      command: "pacman",
      args: ["-Qoq", entry],
      timeout: Duration.seconds(10),
    })
    .pipe(Effect.option);
  if (Option.isNone(ownership) || ownership.value.code !== 0) return undefined;
  const name = ownership.value.stdout.trim().split("\n")[0]?.trim();
  if (!name) return undefined;
  const rebuildCommand = yield* fs
    .readFileString(path.join("/usr/share", name, "rebuild-command"))
    .pipe(Effect.orElseSucceed(() => ""));
  return {
    name,
    rebuildCommand: rebuildCommand.trim() === "" ? undefined : rebuildCommand.trim(),
  } satisfies ManagedPackage;
});

export const resolveManagedPackage = Effect.gen(function* () {
  const entry = yield* resolveEntryPath;
  return yield* detectManagedPackage(entry);
});

export const managedUpdateMessage = (managed: ManagedPackage) =>
  [
    `t3 update is disabled: pacman manages this t3, as package ${managed.name}.`,
    managed.rebuildCommand === undefined
      ? "Rebuild and reinstall the package with your package manager instead."
      : `Rebuild and reinstall the package instead:\n  ${managed.rebuildCommand}`,
  ].join("\n");

export const managedUninstallMessage = (managed: ManagedPackage) =>
  [
    `t3 uninstall is disabled: pacman manages this t3, as package ${managed.name}.`,
    `Remove it with:\n  sudo pacman -Rns ${managed.name}`,
  ].join("\n");
