// Resync with the live nofun-components checkout: `--cache` (also run at the start of a full sync)
// materializes `~/.nofun-t3/caches/nofun-components@<sha>` from `components.pin` via `git fetch` and a
// shared clone (not a worktree) of that commit, then `pnpm install --offline` or a symlinked
// `node_modules`. The rest writes generated/index.json (the component index agents search) and
// generated/compile-report.json (which indexed components compile in isolation; search leaves failures
// out). `--render` also renders each component's demo headless and records runtime errors. Never edits
// the source checkout.
//   vp run --filter @t3tools/nofun-artifacts sync [-- --cache] [-- --render] [--only name,name]
import { execFile } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { compileArtifact } from "../src/compiler.ts";
import { bundle } from "../src/live/bundle.ts";
import { closeProbe } from "../src/live/probe.ts";
import { liveIndex, type IndexEntry } from "../src/live/registry.ts";
import {
  COMPILE_REPORT_FILE,
  GENERATED_DIR,
  INDEX_FILE,
  type CompileReport,
} from "../src/live/report.ts";
import {
  assertComponentsDir,
  DEFAULT_COMPONENTS_DIR,
  pinnedCacheDir,
  readComponentsPin,
} from "../src/live/source.ts";

const run = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

async function git(dir: string, args: readonly string[]): Promise<string> {
  const result = await run("git", ["-C", dir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(),
  });
  return result.stdout.trim();
}

async function cacheReady(dest: string, full: string): Promise<boolean> {
  if (!NodeFs.existsSync(NodePath.join(dest, "registry.json"))) return false;
  if (!NodeFs.existsSync(NodePath.join(dest, "node_modules", "react"))) return false;
  try {
    const head = (await git(dest, ["rev-parse", "HEAD"])).toLowerCase();
    if (head !== full) return false;
    const status = await git(dest, ["status", "--porcelain", "--untracked-files=all"]);
    return status.length === 0;
  } catch {
    return false;
  }
}

async function installCacheDeps(dest: string, sourceRepo: string): Promise<void> {
  const react = NodePath.join(dest, "node_modules", "react");
  if (NodeFs.existsSync(react)) return;
  const env = { ...process.env };
  delete env.ESBUILD_BINARY_PATH;
  try {
    await run("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: dest,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(
      `pnpm install --offline failed (${message}); symlinking node_modules from ${sourceRepo}`,
    );
    const target = NodePath.join(sourceRepo, "node_modules");
    if (!NodeFs.existsSync(NodePath.join(target, "react"))) {
      throw new Error(
        `${sourceRepo} has no node_modules/react to symlink, and pnpm install --offline failed.`,
      );
    }
    const link = NodePath.join(dest, "node_modules");
    NodeFs.rmSync(link, { recursive: true, force: true });
    NodeFs.symlinkSync(target, link);
  }
  if (!NodeFs.existsSync(react)) {
    throw new Error(`Pinned cache at ${dest} still has no node_modules/react.`);
  }
}

/** Fetch origin/main, then create or refresh the pin cache. Does not touch a git worktree. */
async function ensurePinnedCache(): Promise<string> {
  const pin = readComponentsPin();
  const dest = pinnedCacheDir(pin);
  const root = NodePath.join(homedir(), ".nofun-t3", "caches");
  if (!NodePath.resolve(dest).startsWith(`${NodePath.resolve(root)}${NodePath.sep}`)) {
    throw new Error(`Refusing to write a components cache outside ${root}.`);
  }
  const sourceRepo = process.env.NOFUN_COMPONENTS_SOURCE?.trim() || DEFAULT_COMPONENTS_DIR;
  try {
    await run("git", ["-C", sourceRepo, "fetch", "origin", "main"], {
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
      timeout: 60_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(`git fetch origin/main failed (${message}); using the local pin.`);
  }
  const full = (await git(sourceRepo, ["rev-parse", "--verify", `${pin}^{commit}`])).toLowerCase();
  if (!full.startsWith(pin))
    throw new Error(`Pin ${pin} resolved to ${full}, which does not match.`);
  if (await cacheReady(dest, full)) {
    console.log(`cache: ${dest} @ ${full}`);
    return dest;
  }
  try {
    if (NodeFs.lstatSync(dest).isSymbolicLink()) NodeFs.unlinkSync(dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  NodeFs.rmSync(dest, { recursive: true, force: true });
  NodeFs.mkdirSync(root, { recursive: true });
  await run("git", ["clone", "--shared", "--no-checkout", sourceRepo, dest], {
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(),
  });
  await git(dest, ["config", "core.filemode", "false"]);
  await git(dest, ["config", "advice.detachedHead", "false"]);
  await git(dest, ["checkout", "--detach", full]);
  await installCacheDeps(dest, sourceRepo);
  if (!(await cacheReady(dest, full))) {
    throw new Error(`Pinned cache at ${dest} is not a clean checkout of ${full}.`);
  }
  console.log(`cache: ${dest} @ ${full}`);
  return dest;
}

const args = process.argv.slice(2);
const cacheOnly = args.includes("--cache");
await ensurePinnedCache();
if (cacheOnly) process.exit(0);

const render = args.includes("--render");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") && onlyArg ? new Set(onlyArg.split(",")) : undefined;
const CONCURRENCY = render ? 3 : 8;

const dir = assertComponentsDir();
const index = await liveIndex();
NodeFs.mkdirSync(GENERATED_DIR, { recursive: true });
NodeFs.writeFileSync(
  INDEX_FILE,
  `${JSON.stringify({ source: index.stamp, dir, entries: index.entries }, null, 1)}\n`,
);
console.log(
  `index: ${index.entries.length} items (${index.brands.length} brands) from ${dir} @ ${index.stamp}`,
);

const targets = index.entries.filter(
  (entry) =>
    (entry.kind === "block" || entry.kind === "component") && (!only || only.has(entry.name)),
);
const failures: { name: string; stage: "compile" | "render"; reason: string }[] = [];
let compiled = 0;
let rendered = 0;
const timings: { name: string; ms: number; bytes?: number }[] = [];

const firstLine = (text: string) =>
  text.split("\n").find((line) => line.trim() && !line.startsWith("The ")) ?? text.split("\n")[0]!;

async function check(entry: IndexEntry) {
  const started = performance.now();
  const entrySource = entry.demo
    ? `import { ${entry.demo.export} as Demo } from "${entry.demo.import}";\nimport * as M from "${entry.import}";\n(window as any).__nf = [Demo, M];`
    : `import * as M from "${entry.import}";\n(window as any).__nf = M;`;
  try {
    await bundle(dir, index, { entry: entrySource, minify: false });
    compiled += 1;
  } catch (error) {
    const issues = (error as { issues?: string[] }).issues;
    failures.push({
      name: entry.name,
      stage: "compile",
      reason: (issues?.[0] ?? (error as Error).message).slice(0, 300),
    });
    return;
  }
  if (!render || !entry.demo) {
    timings.push({ name: entry.name, ms: Math.round(performance.now() - started) });
    return;
  }
  try {
    const result = await compileArtifact({
      tsx: `import { ${entry.demo.export} as Demo } from "${entry.demo.import}";\nexport default function App() { return <Demo brand="kobra" />; }`,
      theme: "kobra",
      title: entry.title,
    });
    const fatal = result.warnings.filter((w) =>
      /Artifact render failed|Uncaught|is not defined|Cannot read|is not a function|Minified React error/i.test(
        w,
      ),
    );
    if (fatal.length > 0) {
      failures.push({ name: entry.name, stage: "render", reason: fatal[0]!.slice(0, 300) });
    } else {
      rendered += 1;
    }
    timings.push({
      name: entry.name,
      ms: Math.round(performance.now() - started),
      bytes: result.bytes,
    });
  } catch (error) {
    failures.push({
      name: entry.name,
      stage: "render",
      reason: firstLine((error as Error).message).slice(0, 300),
    });
  }
}

let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < targets.length) {
      const entry = targets[next++]!;
      await check(entry);
      process.stdout.write(".");
    }
  }),
);
process.stdout.write("\n");
await closeProbe();

const report: CompileReport = {
  source: index.stamp,
  generatedAt: new Date().toISOString(),
  total: targets.length,
  compiled,
  ...(render ? { rendered } : {}),
  failures: failures.sort((a, b) => a.name.localeCompare(b.name)),
};
if (!only) NodeFs.writeFileSync(COMPILE_REPORT_FILE, `${JSON.stringify(report, null, 1)}\n`);
NodeFs.writeFileSync(
  NodePath.join(GENERATED_DIR, "timings.json"),
  `${JSON.stringify(timings, null, 1)}\n`,
);
console.log(
  `compiled ${compiled}/${targets.length}${render ? `, rendered ${rendered}/${targets.filter((t) => t.demo).length} demos` : ""}`,
);
for (const failure of report.failures)
  console.log(`  ${failure.stage} ${failure.name}: ${failure.reason}`);
