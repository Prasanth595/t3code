// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs CI's fast checks for this branch's changes: format and lint of the
// changed files, knip, generated GraphQL operations, typecheck of the affected
// packages and their dependents, and the test files beside the changed files.
// CI still runs the full test suites and the jobs listed in the summary.
//
//   vp run check:changed          compare against the merge base with origin/main
//   vp run check:changed <ref>    compare against the merge base with <ref>
//
// Uncommitted and untracked files count. Affected packages come from
// .github/scripts/ci-changes.cjs, the same mapping CI uses to gate its jobs.
// The steps run side by side; each prints its output when it finishes. A
// rerun on exactly the files of the last passing run prints that run's summary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const CODE = /\.[cm]?[jt]sx?$/;

const git = (...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const ref = process.argv[2] ?? "origin/main";
const mergeBase = NodeChildProcess.spawnSync("git", ["merge-base", "HEAD", ref], {
  cwd: root,
  encoding: "utf8",
});
if (mergeBase.status !== 0) {
  console.error(
    `check:changed: no merge base with ${ref}. Run \`git fetch origin\` or pass a ref.`,
  );
  process.exit(1);
}
const base = mergeBase.stdout.trim();
// --no-renames lists a rename as its old and new path, as CI does.
const untracked = git("ls-files", "--others", "--exclude-standard");
const files = [
  ...new Set([...git("diff", "--name-only", "--no-renames", base, "--"), ...untracked]),
].sort();

if (files.length === 0) {
  console.log(`check:changed: no changes since ${base.slice(0, 12)}.`);
  process.exit(0);
}
console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)}`);

// The checked tree is the merge base plus the diff plus the untracked files.
// Ignored files outside node_modules (generated sources, .astro types) and the
// install state can change results too, so they are part of the key.
// tsbuildinfo files are excluded: typecheck rewrites them on every run.
// Computed again after a passing run, so edits made during the run are never
// cached as passing.
const inputKey = () => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(`${process.version}\0${base}\0`);
  hash.update(
    NodeChildProcess.execFileSync("git", ["diff", "--binary", "--no-renames", base, "--"], {
      cwd: root,
      maxBuffer: 1024 * 1024 * 1024,
    }),
  );
  const ignored = git(
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":!node_modules/**",
    ":!**/node_modules/**",
    ":!.t3/**",
    ":!**/*.tsbuildinfo",
  );
  for (const file of [
    ...git("ls-files", "--others", "--exclude-standard"),
    ...ignored,
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
  ]) {
    hash.update(`\0${file}\0`);
    const path = NodePath.join(root, file);
    if (NodeFS.existsSync(path)) hash.update(NodeFS.readFileSync(path));
  }
  return hash.digest("hex");
};
const key = inputKey();
const cachePath = NodePath.join(root, "node_modules/.cache/check-changed.json");
const cached = NodeFS.existsSync(cachePath)
  ? (JSON.parse(NodeFS.readFileSync(cachePath, "utf8")) as { key: string; summary: Array<string> })
  : undefined;
if (cached?.key === key) {
  console.log("Nothing changed since the last passing run.\n");
  for (const line of cached.summary) console.log(line);
  process.exit(0);
}

const present = files.filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
const code = present.filter((file) => CODE.test(file));
const packages = readWorkspace();
const { affected, outputs } = decide(files, packages, false);

// Changed test files, and the test files beside a changed source file
// (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
// `related` reaches most of a package: one leaf server file pulled in 252 of
// 406 server test files and took 7 minutes. CI runs the rest.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const tests = new Set(code.filter((file) => TEST.test(file)));
for (const file of code) {
  const dir = NodePath.dirname(file);
  const prefix = `${NodePath.basename(file).replace(CODE, "")}.`;
  for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
    if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.join(dir, entry));
  }
}

// knip:check cannot be scoped to a package. Any code change can leave a file,
// export, or dependency unused (removing the last import of a helper does), so
// it runs whenever code or a manifest changes.
const runKnip = files.some(
  (file) => CODE.test(file) || NodePath.basename(file) === "package.json" || file === "knip.jsonc",
);
// CI runs knip:check as one script of `knip ... && knip ...` passes. The passes
// do not depend on each other, so they run side by side here.
const knipCheck: string = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"),
).scripts["knip:check"];
const knipPasses = knipCheck.split(" && ").map((command, index, all) => {
  const [bin, ...args] = command.trim().split(/\s+/);
  if (bin !== "knip" || /["'$\\|;&<>]/.test(command)) {
    throw new Error(`check:changed cannot split knip:check: ${command}`);
  }
  return { name: `knip ${index + 1}/${all.length}`, args: ["exec", "knip", ...args] };
});

// CI's Lint job checks that generated GraphQL operations match their sources.
const graphql = ["apps/server", "packages/source-control-github"].filter((dir) =>
  files.some((file) => file.startsWith(`${dir}/`)),
);

const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
const steps = [
  present.length > 0 && {
    name: "format",
    args: ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present],
  },
  code.length > 0 && { name: "lint", args: ["lint", ...code] },
  ...(runKnip ? knipPasses : []),
  ...graphql.map((dir) => ({
    name: `graphql (${dir})`,
    args: ["run", "--filter", `./${dir}`, "generate", "--check"],
  })),
  affected.length > 0 && {
    name: `typecheck (${affected.length} packages)`,
    // `tsc --noEmit` writes nothing another package reads, so dependency order
    // only made dependents wait: --parallel cut a contracts change from 13 s to 9 s.
    args: [
      "run",
      "--cache",
      "--parallel",
      "--concurrency-limit",
      "4",
      ...filters(affected),
      "typecheck",
    ],
  },
  // From the repo root, the root vite.config.ts hands each file to its package's config.
  tests.size > 0 && {
    name: `test (${tests.size} files)`,
    args: ["test", "run", "--passWithNoTests", ...tests],
  },
].filter((step) => step !== false);

// Output is piped, so keep the colors a terminal would get.
const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
const results = await Promise.all(
  steps.map(
    (step) =>
      new Promise<{ name: string; ok: boolean; seconds: string }>((resolve) => {
        const started = performance.now();
        const output: Array<Buffer> = [];
        const child = NodeChildProcess.spawn("vp", step.args, { cwd: root, env });
        child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
        // A failed spawn emits "error", then "close" with a nonzero code.
        child.on("error", (error) => output.push(Buffer.from(`${error.message}\n`)));
        child.on("close", (status) => {
          const ok = status === 0;
          const seconds = ((performance.now() - started) / 1000).toFixed(1);
          console.log(`\n> vp ${step.name}  ${ok ? "pass" : "FAIL"}  ${seconds}s`);
          process.stdout.write(Buffer.concat(output));
          resolve({ name: step.name, ok, seconds });
        });
      }),
  ),
);

const summary = ["check:changed summary"];
for (const result of results) {
  summary.push(`  ${result.ok ? "pass" : "FAIL"}  ${result.name}  ${result.seconds}s`);
}
const ciOnly = Object.entries({
  "full test suites": outputs.test || outputs.test_web || outputs.test_server,
  build: outputs.build,
  rust: outputs.rust,
  "mobile native lint": outputs.mobile_native,
  "release smoke": outputs.release_smoke,
}).flatMap(([job, runs]) => (runs ? [job] : []));
if (ciOnly.length > 0) summary.push(`  CI also runs: ${ciOnly.join(", ")}`);
if (!runKnip) summary.push("  knip skipped: no code or manifest changed");
console.log(`\n${summary.join("\n")}`);
// exitCode, not exit(): piped stdout is asynchronous on macOS, and exit()
// would cut off a failing step's output.
if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
} else if (inputKey() !== key) {
  console.log("  pass not cached: files changed during the run");
} else {
  try {
    NodeFS.mkdirSync(NodePath.dirname(cachePath), { recursive: true });
    NodeFS.writeFileSync(cachePath, JSON.stringify({ key, summary }));
  } catch (error) {
    console.warn(`  pass not cached: ${error instanceof Error ? error.message : String(error)}`);
  }
}
