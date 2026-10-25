// @effect-diagnostics nodeBuiltinImport:off - installs the hook before running project tasks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (process.env.GITHUB_REPOSITORY !== "pingdotgg/t3code" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("This setup is only for the maintainer repository's GitHub Actions.");
const root = NodePath.resolve(import.meta.dirname, "../../..");
const hookConfig = NodePath.join(NodeOS.homedir(), ".config/vite-plus/run-hook.json");
await NodeFSP.mkdir(NodePath.dirname(hookConfig), { recursive: true });
await NodeFSP.writeFile(
  hookConfig,
  JSON.stringify({
    rootMarker: ".task-cache.json",
    module: NodePath.join(root, "infra/task-cache/src/runHook.ts"),
  }),
);
const { endpoint } = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, ".task-cache.json"), "utf8"),
);
const githubEnv = process.env.GITHUB_ENV;
if (!githubEnv) throw new Error("Missing GitHub Actions environment file");
const preload = NodeURL.pathToFileURL(NodePath.join(root, "infra/task-cache/src/preload.mjs")).href;
await NodeFSP.appendFile(
  githubEnv,
  `VP_REMOTE_CACHE_URL=${endpoint}\nNODE_OPTIONS=${process.env.NODE_OPTIONS || ""} --import=${preload}\n`,
);
