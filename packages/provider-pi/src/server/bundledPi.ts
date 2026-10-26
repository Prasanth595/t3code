// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_PI_COMMAND = "pi";

const resolveBundledPiCli = (): string | undefined => {
  try {
    // The package does not export package.json, so walk up from its entry point.
    let directory = NodePath.dirname(
      NodeURL.fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    while (directory !== NodePath.dirname(directory)) {
      const manifestPath = NodePath.join(directory, "package.json");
      if (NodeFS.existsSync(manifestPath)) {
        const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
          readonly name?: string;
          readonly bin?: Record<string, string>;
        };
        if (manifest.name === "@earendil-works/pi-coding-agent") {
          const bin = manifest.bin?.["pi"];
          return bin === undefined ? undefined : NodePath.join(directory, bin);
        }
      }
      directory = NodePath.dirname(directory);
    }
  } catch {
    // Fall back to `pi` on PATH.
  }
  return undefined;
};

let bundledPiCli: string | undefined | null = null;

const readBundledPiCli = (): string | undefined => {
  if (bundledPiCli === null) bundledPiCli = resolveBundledPiCli();
  return bundledPiCli;
};

/**
 * Writes `pi` launchers for the bundled CLI into `directory` so T3 terminals can run it.
 * Returns the directory, or undefined when no bundled CLI ships with this build.
 */
export function writeBundledPiLaunchers(
  directory: string,
  platform: NodeJS.Platform,
): string | undefined {
  const cli = readBundledPiCli();
  if (cli === undefined) return undefined;
  NodeFS.mkdirSync(directory, { recursive: true });
  const node = process.execPath;
  if (platform === "win32") {
    NodeFS.writeFileSync(
      NodePath.join(directory, "pi.cmd"),
      `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${node}" "${cli}" %*\r\n`,
    );
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const launcher = NodePath.join(directory, "pi");
    NodeFS.writeFileSync(
      launcher,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(node)} ${quote(cli)} "$@"\n`,
    );
    NodeFS.chmodSync(launcher, 0o755);
  }
  return directory;
}

/** Runs the Pi CLI shipped with T3 Code unless the user configured a custom binary path. */
export function resolvePiCommand(
  binaryPath: string | undefined,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const configured = binaryPath?.trim() || DEFAULT_PI_COMMAND;
  if (configured !== DEFAULT_PI_COMMAND) return { command: configured, args, env };
  const cli = readBundledPiCli();
  if (cli === undefined) return { command: configured, args, env };
  // Desktop hosts the server inside Electron; this keeps the child on Electron's Node runtime.
  return {
    command: process.execPath,
    args: [cli, ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}
