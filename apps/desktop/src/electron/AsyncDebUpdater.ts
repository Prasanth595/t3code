// @effect-diagnostics nodeBuiltinImport:off -- Package installation runs at the native Electron adapter boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { autoUpdater as nativeAutoUpdater } from "electron";
import { DebUpdater } from "electron-updater";

const quoteShellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const runInstallCommand = (command: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          PATH: (process.env.PATH ?? "")
            .split(NodePath.delimiter)
            .filter(NodePath.isAbsolute)
            .join(NodePath.delimiter),
        },
      },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });

/** Keep authentication and package installation off Electron's main event loop. */
export class AsyncDebUpdater extends DebUpdater {
  private runPackageCommand(command: string, args: readonly string[]) {
    if (this.isRunningAsRoot()) return runInstallCommand(command, args);
    const [sudo, ...sudoArgs] = this.sudoWithArgs(`${this.app.name} would like to update`);
    if (!sudo) return Promise.reject(new Error("No elevation command available."));
    // gksudo/kdesudo accept a command string; pkexec/sudo/beesu accept argv.
    const elevatedArgs = /gksudo|kdesudo/i.test(sudo)
      ? [...sudoArgs, [command, ...args].map(quoteShellArgument).join(" ")]
      : [...sudoArgs, command, ...args];
    return runInstallCommand(sudo, elevatedArgs);
  }

  override async quitAndInstall(_isSilent = false, isForceRunAfter = false): Promise<void> {
    if (this.quitAndInstallCalled) return;
    // LinuxUpdater.installerPath is shell-escaped. execFile needs the raw path.
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
      if (isForceRunAfter) this.app.relaunch();
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
