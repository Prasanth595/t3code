/* oxlint-disable t3code/no-global-process-runtime -- Standalone setup must run before workspace dependencies are installed. */
// @effect-diagnostics nodeBuiltinImport:off - standalone bootstrap also runs before dependencies are installed.
// @effect-diagnostics globalConsole:off globalFetch:off globalDate:off - interactive setup and endpoint verification.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeReadlinePromises from "node:readline/promises";
import { patchNativeCli } from "../src/nativeHook.ts";

const home = NodeOS.homedir();
const root = NodePath.resolve(import.meta.dirname, "../../..");
const state = NodePath.join(home, ".config/t3-task-cache");
const nonInteractive = process.argv.includes("--non-interactive");
const { endpoint: defaultEndpoint } = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, ".task-cache.json"), "utf8"),
);
let credentials: Record<string, { name: string; token: string }> = {};
try {
  credentials = JSON.parse(
    await NodeFSP.readFile(NodePath.join(state, "credentials.json"), "utf8"),
  );
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const prompt = NodeReadlinePromises.createInterface({
  input: process.stdin,
  output: process.stdout,
});
let endpoint = process.env.T3_CACHE_SETUP_URL || defaultEndpoint;
let name = process.env.T3_CACHE_SETUP_NAME || credentials[endpoint]?.name;
let token = process.env.T3_CACHE_SETUP_TOKEN || credentials[endpoint]?.token;
const initialEndpoint = endpoint;
const initialName = name;
try {
  if (!nonInteractive) {
    endpoint = (await prompt.question(`Cache URL [${endpoint}]: `)).trim() || endpoint;
    name = (await prompt.question(`Developer name${name ? ` [${name}]` : ""}: `)).trim() || name;
    prompt.close();
    if (!token || endpoint !== initialEndpoint || name !== initialName) {
      if (!process.stdin.isTTY)
        throw new Error("Use T3_CACHE_SETUP_TOKEN for non-interactive setup.");
      process.stdout.write("Credential token (hidden): ");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      token = await new Promise<string>((resolve, reject) => {
        let value = "";
        const data = (chunk: Buffer) => {
          for (const character of chunk.toString()) {
            if (character === "\u0003") {
              cleanup();
              reject(new Error("Cancelled"));
              return;
            }
            if (character === "\r" || character === "\n") {
              cleanup();
              resolve(value);
              return;
            }
            if (character === "\u007f") value = value.slice(0, -1);
            else value += character;
          }
        };
        const cleanup = () => {
          process.stdin.off("data", data);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
        };
        process.stdin.on("data", data);
      });
    }
  }
} finally {
  prompt.close();
}
if (!name || !token || !/^[a-z0-9-]{1,64}$/.test(name) || token.length < 32)
  throw new Error("A valid developer name and credential token are required.");
const url = new URL(endpoint);
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error("Use a cache endpoint without embedded credentials, query, or fragment.");
endpoint = url.href.replace(/\/$/, "");
const response = await fetch(`${endpoint}/telemetry`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${name}:${token}`).toString("base64")}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    id: NodeCrypto.randomBytes(32).toString("hex"),
    recordedAt: Date.now(),
    host: NodeOS.hostname(),
    platform: NodeOS.platform(),
    arch: NodeOS.arch(),
    ci: false,
    runId: "setup",
    tasks: [],
  }),
  signal: AbortSignal.timeout(10_000),
});
await response.body?.cancel();
if (!response.ok)
  throw new Error(`Credential verification failed (${response.status}); nothing was installed.`);

const candidates = [NodePath.join(root, "node_modules/vite-plus/dist/bin.js")];
for (const directory of [
  process.env.VITE_PLUS_HOME,
  NodePath.join(home, ".vite-plus/current"),
  NodePath.join(home, ".local/share/vite-plus/current"),
]) {
  if (directory) candidates.push(NodePath.join(directory, "node_modules/vite-plus/dist/bin.js"));
}
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] === "--entrypoint") {
    const entrypoint = process.argv[++index];
    if (!entrypoint) throw new Error("Missing --entrypoint path");
    candidates.push(entrypoint);
  }
}
const targets = new Map<string, { original: string; patched: string }>();
for (const candidate of candidates) {
  try {
    const path = await NodeFSP.realpath(candidate);
    const original = await NodeFSP.readFile(path, "utf8");
    targets.set(path, { original, patched: patchNativeCli(original) });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
if (!targets.size) throw new Error("Install Vite+ before installing its telemetry hook.");
const installed = NodePath.join(home, ".local/share/t3-task-cache");
await NodeFSP.mkdir(installed, { recursive: true });
await NodeFSP.writeFile(NodePath.join(installed, "package.json"), '{"type":"module"}\n');
for (const file of [
  "runHook.ts",
  "telemetry.ts",
  "nativeHook.ts",
  "nativeRunHook.js",
  "preload.mjs",
])
  await NodeFSP.copyFile(
    NodePath.join(import.meta.dirname, "../src", file),
    NodePath.join(installed, file),
  );
const hookConfig = NodePath.join(home, ".config/vite-plus/run-hook.json");
await NodeFSP.mkdir(NodePath.dirname(hookConfig), { recursive: true });
await NodeFSP.writeFile(
  hookConfig,
  JSON.stringify({
    rootMarker: ".task-cache.json",
    module: NodePath.join(installed, "runHook.ts"),
  }),
);
for (const [path, { original, patched }] of targets) {
  try {
    const backup = await NodeFSP.readFile(`${path}.before-task-cache`, "utf8");
    if (original === patchNativeCli(backup) && original === patched)
      await NodeFSP.writeFile(path, backup);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
await NodeFSP.mkdir(state, { recursive: true, mode: 0o700 });
credentials[endpoint] = { name, token };
await NodeFSP.writeFile(NodePath.join(state, "credentials.json"), JSON.stringify(credentials), {
  mode: 0o600,
});
await NodeFSP.chmod(NodePath.join(state, "credentials.json"), 0o600);

const environmentFile = NodePath.join(state, "env");
const preload = NodeURL.pathToFileURL(NodePath.join(installed, "preload.mjs")).href;
await NodeFSP.writeFile(
  environmentFile,
  [
    `case " \${NODE_OPTIONS-} " in`,
    `  *" --import=${preload} "*) ;;`,
    `  *) export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--import=${preload}" ;;`,
    `esac`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const sourceLine = '. "$HOME/.config/t3-task-cache/env"';
for (const file of [".profile", ".bashrc", ".bash_profile", ".bash_login", ".zshenv", ".zshrc"]) {
  const path = NodePath.join(home, file);
  let original = "";
  try {
    original = await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (file === ".bash_profile" || file === ".bash_login") {
    if (!original) continue;
    // Earlier installers created a profile that masks the user’s existing login profile.
    if (file === ".bash_profile" && original.trim() === sourceLine) {
      await NodeFSP.unlink(path);
      continue;
    }
  }
  if (!original.split("\n").includes(sourceLine))
    await NodeFSP.appendFile(path, `\n${sourceLine}\n`);
}
console.log(
  "Verified credentials and installed the machine-wide Vite+ hook. Open a fresh shell to enable it in all worktrees. Executables and PATH are unchanged.",
);
