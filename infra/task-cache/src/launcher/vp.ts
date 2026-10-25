#!/usr/bin/env node
// @effect-diagnostics globalConsole:off - standalone CLI output.
// @effect-diagnostics nodeBuiltinImport:off - installed outside the repository and runs before dependency installation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { flushTelemetry, observeSummaries } from "./launcherTelemetry.ts";

export function cacheEnvironment(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home = NodeOS.homedir(),
  args: string[] = [],
) {
  if (args[0] === "-C" && args[1]) cwd = NodePath.resolve(cwd, args[1]);
  else if (args[0]?.startsWith("-C") && args[0].length > 2)
    cwd = NodePath.resolve(cwd, args[0].slice(2));
  let directory = NodePath.resolve(cwd);
  while (!NodeFS.existsSync(NodePath.join(directory, ".task-cache.json"))) {
    const parent = NodePath.dirname(directory);
    if (parent === directory) return env;
    directory = parent;
  }
  const { endpoint } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, ".task-cache.json"), "utf8"),
  );
  const url = new URL(endpoint);
  let credential;
  try {
    const credentials = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, ".config/t3-task-cache/credentials.json"), "utf8"),
    );
    credential = credentials[endpoint];
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (credential) {
    url.username = credential.name;
    url.password = credential.token;
  }
  return {
    ...env,
    VP_REMOTE_CACHE_URL: env.VP_REMOTE_CACHE_URL || url.href.replace(/\/$/, ""),
    VP_REMOTE_CACHE: env.VP_REMOTE_CACHE || (credential ? "read-write" : "read"),
  };
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--t3-flush-telemetry") {
    await flushTelemetry();
    process.exit(0);
  }
  const self = NodeFS.realpathSync(process.argv[1]);
  const args = process.argv.slice(2);
  if (NodePath.basename(process.argv[1]) === "vpr") {
    const at = args[0] === "-C" ? 2 : args[0]?.startsWith("-C") ? 1 : 0;
    args.splice(at, 0, "run");
  }
  const executable = (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((directory) => NodePath.join(directory, "vp"))
    .find((candidate) => NodeFS.existsSync(candidate) && NodeFS.realpathSync(candidate) !== self);
  if (!executable) throw new Error("Install Vite+ before enabling the task cache.");
  const env = cacheEnvironment(process.cwd(), process.env, NodeOS.homedir(), args);
  let stopObserving = () => {};
  if (env !== process.env && env.T3_TASK_CACHE_TELEMETRY !== "off") {
    let root = process.cwd();
    if (args[0] === "-C" && args[1]) root = NodePath.resolve(root, args[1]);
    else if (args[0]?.startsWith("-C")) root = NodePath.resolve(root, args[0].slice(2));
    while (!NodeFS.existsSync(NodePath.join(root, ".task-cache.json")))
      root = NodePath.dirname(root);
    const endpoint = new URL(env.VP_REMOTE_CACHE_URL!);
    endpoint.username = "";
    endpoint.password = "";
    stopObserving = observeSummaries(root, endpoint.href.replace(/\/$/, ""), env);
  }
  const child = NodeChildProcess.spawn(executable, args, {
    env: env === process.env ? env : { ...env, T3_TASK_CACHE_PARENT: "1" },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    stopObserving();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    stopObserving();
    if (
      env !== process.env &&
      !process.env.T3_TASK_CACHE_PARENT &&
      env.T3_TASK_CACHE_TELEMETRY !== "off"
    ) {
      if (env.GITHUB_ACTIONS === "true") {
        // Runners terminate background processes when a step ends.
        void flushTelemetry().finally(() => {
          process.exitCode = code ?? 1;
        });
      } else {
        NodeChildProcess.spawn(process.execPath, [self, "--t3-flush-telemetry"], {
          detached: true,
          stdio: "ignore",
          env,
        }).unref();
      }
    }
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exitCode = code ?? 1;
  });
}
