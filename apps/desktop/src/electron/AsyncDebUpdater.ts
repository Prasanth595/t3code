import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { autoUpdater as nativeAutoUpdater } from "electron";
import { DebUpdater } from "electron-updater";

class DebInstallCommandError extends Schema.TaggedError<DebInstallCommandError>()(
  "DebInstallCommandError",
  { command: Schema.String, exitCode: Schema.Number },
) {
  override get message() {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

const quoteShellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const runInstallCommand = (command: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        env: { PATH: (process.env.PATH ?? "").split(":").filter(path.isAbsolute).join(":") },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (exitCode !== 0) return yield* new DebInstallCommandError({ command, exitCode });
  });

/** Keep authentication and package installation off Electron's main event loop. */
export class AsyncDebUpdater extends DebUpdater {
  readonly runInstallCommand: (command: string, args: readonly string[]) => Promise<void>;

  constructor(run: (command: string, args: readonly string[]) => Promise<void>) {
    super();
    this.runInstallCommand = run;
  }
  private runPackageCommand(command: string, args: readonly string[]) {
    if (this.isRunningAsRoot()) return this.runInstallCommand(command, args);
    const [sudo, ...sudoArgs] = this.sudoWithArgs(`${this.app.name} would like to update`);
    if (!sudo) return Promise.reject(new Error("No elevation command available."));
    // gksudo/kdesudo accept a command string; pkexec/sudo/beesu accept argv.
    const elevatedArgs = /gksudo|kdesudo/i.test(sudo)
      ? [...sudoArgs, [command, ...args].map(quoteShellArgument).join(" ")]
      : [...sudoArgs, command, ...args];
    return this.runInstallCommand(sudo, elevatedArgs);
  }

  override async quitAndInstall(isSilent = false, isForceRunAfter = false): Promise<void> {
    if (this.quitAndInstallCalled) return;
    // LinuxUpdater.installerPath is shell-escaped. The process spawner needs the raw path.
    const installerPath = this.downloadedUpdateHelper?.file;
    if (!installerPath || !this.downloadedUpdateHelper?.downloadedFileInfo) {
      throw new Error("No downloaded .deb available to install.");
    }
    this.quitAndInstallCalled = true;
    try {
      if (!this.hasCommand("dpkg") && !this.hasCommand("apt")) {
        throw new Error("Neither dpkg nor apt command found. Cannot install .deb package.");
      }
      const packageManager = this.detectPackageManager(["dpkg", "apt"]);
      if (packageManager === "dpkg") {
        try {
          await this.runPackageCommand("dpkg", ["-i", installerPath]);
        } catch (error) {
          this._logger.warn(error instanceof Error ? error.message : String(error));
          this._logger.warn(
            "dpkg installation failed, trying to fix broken dependencies with apt-get",
          );
          await this.runPackageCommand("apt-get", ["install", "-f", "-y"]);
        }
      } else if (packageManager === "apt") {
        await this.runPackageCommand("apt", [
          "install",
          "-y",
          "--allow-unauthenticated",
          "--allow-downgrades",
          "--allow-change-held-packages",
          installerPath,
        ]);
      } else {
        throw new Error(`Package manager ${packageManager} not supported`);
      }
      if (isSilent ? isForceRunAfter : this.autoRunAppAfterInstall) this.app.relaunch();
    } catch (error) {
      this.quitAndInstallCalled = false;
      throw error;
    }
    setImmediate(() => {
      nativeAutoUpdater.emit("before-quit-for-update");
      this.app.quit();
    });
  }
}

/** Bridge the desktop runtime's process service into electron-updater's Promise API. */
export const make = Effect.gen(function* () {
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>();
  const run = Effect.runPromiseWith(context);
  return new AsyncDebUpdater((command, args) => run(runInstallCommand(command, args)));
});
