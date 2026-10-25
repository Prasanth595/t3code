// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime starts, on raw file descriptors.
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Electron's Windows GUI executable can start with missing or non-TTY stdin.
 * Pipes, files, and runs whose output is not a console are left alone.
 */
const needsConsoleStdin = () => {
  if (NodeTty.isatty(0)) return false;
  try {
    // Electron can leave stdin open on a non-TTY character device instead of closing it.
    return NodeFS.fstatSync(0).isCharacterDevice();
  } catch {
    return true;
  }
};

/** Call before reading process.stdin. Returns the reopened fd for children, or undefined without changing stdin. */
export function attachConsoleStdin(): number | undefined {
  const needed =
    HostProcess.Platform.defaultValue() === "win32" &&
    process.env.T3CODE_DESKTOP_CLI_LAUNCHER === "1" &&
    NodeTty.isatty(1) &&
    needsConsoleStdin();
  // The launcher marker must not propagate to child shells or t3 processes.
  delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
  if (!needed) return undefined;
  let fd: number;
  try {
    fd = NodeFS.openSync("\\\\.\\CONIN$", "r+");
  } catch {
    return undefined;
  }
  if (!NodeTty.isatty(fd)) {
    NodeFS.closeSync(fd);
    return undefined;
  }
  const stdin = new NodeTty.ReadStream(fd);
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true });
  consoleStdinFd = fd;
  return fd;
}

let consoleStdinFd: number | undefined;

export const interactiveStdin = (): number | "inherit" => consoleStdinFd ?? "inherit";
