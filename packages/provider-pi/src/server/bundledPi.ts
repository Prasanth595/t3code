// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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

const MIRA_BASE_URL_ENV = "MIRA_BASE_URL";
const MIRA_API_KEY_ENV = "MIRA_API_KEY";
const MIRA_PROVIDER_ID = "mira";
const MIRA_MODEL_ID = "mira";

const MIRA_PROVIDER_EXTENSION_SOURCE = `export default function (pi) {
  const baseUrl = process.env[${JSON.stringify(MIRA_BASE_URL_ENV)}];
  if (!baseUrl) return;
  pi.registerProvider(${JSON.stringify(MIRA_PROVIDER_ID)}, {
    name: "Mira",
    baseUrl,
    apiKey: ${JSON.stringify(`$${MIRA_API_KEY_ENV}`)},
    api: "openai-completions",
    models: [
      {
        type: "chat",
        id: ${JSON.stringify(MIRA_MODEL_ID)},
        name: "Mira",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
}
`;

let miraExtensionPath: string | undefined;

const writeMiraExtension = (): string => {
  if (miraExtensionPath !== undefined) return miraExtensionPath;
  const directory = NodePath.join(NodeOS.tmpdir(), "t3-mira-pi");
  NodeFS.mkdirSync(directory, { recursive: true });
  const path = NodePath.join(directory, "mira-provider.js");
  NodeFS.writeFileSync(path, MIRA_PROVIDER_EXTENSION_SOURCE);
  miraExtensionPath = path;
  return path;
};

/**
 * With a Mira account, sessions register the Mira provider and start on its model, so
 * selections that inherit Pi's default run on the account's plan.
 */
function withMiraProvider(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  if (!env[MIRA_BASE_URL_ENV]?.trim() || !env[MIRA_API_KEY_ENV]?.trim()) return args;
  if (!args.includes("--mode")) return args;
  return [
    "--extension",
    writeMiraExtension(),
    "--provider",
    MIRA_PROVIDER_ID,
    "--model",
    MIRA_MODEL_ID,
    ...args,
  ];
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
  args = withMiraProvider(args, env);
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
