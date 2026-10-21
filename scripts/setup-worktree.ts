// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);

// T3 runs setup in the background, so agents can start before it ends. They
// wait for one of these markers instead of racing it with their own `vp i`.
const markerDir = NodePath.join(worktree, ".t3");
const doneMarker = NodePath.join(markerDir, "setup-done");
const failedMarker = NodePath.join(markerDir, "setup-failed");
NodeFS.rmSync(doneMarker, { force: true });
NodeFS.rmSync(failedMarker, { force: true });
let failureDetail = "";
process.on("uncaughtExceptionMonitor", (error) => {
  failureDetail = error.stack ?? String(error);
});
process.on("exit", (code) => {
  NodeFS.mkdirSync(markerDir, { recursive: true });
  if (code === 0) NodeFS.writeFileSync(doneMarker, "");
  else NodeFS.writeFileSync(failedMarker, `Setup exited with code ${code}.\n${failureDetail}\n`);
});
// A cancelled setup must still leave a marker, or agents would wait forever.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => process.exit(1));
}

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}

// `shell` resolves `vp` through PATH, including Windows command shims.
// Setup has no one answering install prompts. Pass pnpm's confirmation flag
// through vp and leave stdin closed so other prompts fail instead of hanging.
// Install exactly the locked dependencies so setup never rewrites the lockfile.
// A stale lockfile must fail setup rather than silently resolving a new one.
// Output is piped, not inherited, so a failure can keep its tail in the marker.
const install = NodeChildProcess.spawn("vp i --frozen-lockfile -- --yes", {
  cwd: worktree,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let installOutput = "";
for (const [source, target] of [
  [install.stdout, process.stdout],
  [install.stderr, process.stderr],
] as const) {
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    target.write(chunk);
    installOutput = (installOutput + chunk).slice(-8_000);
  });
}
const installStatus = await new Promise<number | null>((resolve) => install.on("close", resolve));
if (installStatus !== 0) {
  failureDetail = installOutput.trimEnd().split("\n").slice(-30).join("\n");
  process.exit(installStatus ?? 1);
}

// pnpm cannot clone or hardlink across filesystems, so a store on another
// device silently turns every worktree install into a full copy.
const storeDir: unknown = JSON.parse(
  NodeFS.readFileSync(NodePath.join(worktree, "node_modules", ".modules.yaml"), "utf8"),
).storeDir;
if (
  typeof storeDir === "string" &&
  NodeFS.statSync(storeDir).dev !== NodeFS.statSync(NodePath.join(worktree, "node_modules")).dev
) {
  process.stderr.write(
    [
      "",
      "WARNING: the pnpm store is on a different filesystem than this worktree.",
      `  store:    ${storeDir}`,
      `  worktree: ${worktree}`,
      "pnpm cannot hardlink or clone across filesystems, so it copied every package into node_modules.",
      "Fix: put the store on the worktree's filesystem, for example:",
      `  pnpm config set store-dir ${NodePath.join(NodePath.dirname(worktree), ".pnpm-store")} --global`,
      "",
      "",
    ].join("\n"),
  );
}

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
