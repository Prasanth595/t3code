#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node script.
// Fork: the quick Fork CI checks, on the files that changed since the merge base with origin/main.
// Run it before every push. See docs/fork/operations.md "Check a change before you push".
//
//   vp run fork:check
//
// It checks the working tree, so uncommitted and untracked files count. The steps run at the
// same time. Each step prints one summary line, and a failed step also prints its output.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Fork CI checks that this command does not run. Keep in sync with .github/workflows/fork-ci.yml. */
const NOT_COVERED = [
  "the full test suites of the Test, Test Web and Test Server jobs (only the tests below run)",
  "typecheck of the packages that depend on a changed package",
  "the desktop build (Build job) and the Rust crates (Rust job)",
  "the .github/scripts tests and Fork Android, Fork Release and Fork Sync",
];
const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".browser.test.ts", ".browser.test.tsx"];
/** Tests that run on every check. */
const ALWAYS_TESTS = ["apps/web/src/components/settings/forkSettingsRegistration.test.ts"];
/**
 * Tests that fail on a change anywhere in their app, so they run on any change there: React
 * Compiler coverage, and the mobile import cycle check (about 1.5 s).
 */
const APP_WIDE_TESTS = {
  "apps/web/": ["apps/web/src/reactCompilerCoverage.test.ts"],
  "apps/mobile/": [
    "apps/mobile/src/reactCompilerCoverage.test.ts",
    "apps/mobile/src/dependency-graph.test.ts",
  ],
};

interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
  readonly scripts: Readonly<Record<string, string>>;
}

type Step =
  | { readonly name: string; readonly skipped: string }
  | { readonly name: string; readonly detail: string; readonly command: ReadonlyArray<string> };

interface StepResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
  readonly output: string;
}

function git(...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
}

function lines(text: string): ReadonlyArray<string> {
  return text.split("\n").filter((line) => line !== "");
}

const repoRoot = git("rev-parse", "--show-toplevel");
process.chdir(repoRoot);

let base: string;
try {
  base = git("merge-base", "origin/main", "HEAD");
} catch {
  console.error("No merge base with origin/main. Run `git fetch origin main` and try again.");
  process.exit(2);
}

const changed = [
  ...new Set([
    ...lines(git("diff", "--name-only", "--diff-filter=ACMR", base)),
    ...lines(git("ls-files", "--others", "--exclude-standard")),
  ]),
]
  .filter((file) => NodeFS.existsSync(file))
  .sort();

/** The workspace package folders, from the `packages:` list of pnpm-workspace.yaml. */
function workspacePackages(): ReadonlyArray<WorkspacePackage> {
  const workspaceLines = NodeFS.readFileSync("pnpm-workspace.yaml", "utf8").split("\n");
  const start = workspaceLines.indexOf("packages:") + 1;
  const end = workspaceLines.findIndex((line, index) => index >= start && !line.startsWith("  - "));
  const globs = workspaceLines.slice(start, end).map((line) => `${line.slice(4)}/package.json`);
  return NodeFS.globSync(globs).map((manifest) => {
    const json = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
      readonly name: string;
      readonly scripts?: Record<string, string>;
    };
    return { dir: NodePath.dirname(manifest), name: json.name, scripts: json.scripts ?? {} };
  });
}

const packages = workspacePackages();

function packageOf(file: string): WorkspacePackage | undefined {
  return packages
    .filter((candidate) => file.startsWith(`${candidate.dir}/`))
    .toSorted((left, right) => right.dir.length - left.dir.length)[0];
}

function isDocFile(file: string): boolean {
  return file.startsWith("docs/") || file.endsWith(".md");
}

function stripExtension(file: string): string {
  return file.slice(0, file.length - NodePath.extname(file).length);
}

/** Tests next to a changed source file: `foo.ts` has `foo.test.ts` and the other suffixes. */
function testsFor(file: string): ReadonlyArray<string> {
  if (TEST_SUFFIXES.some((suffix) => file.endsWith(suffix))) return [file];
  if (!SCRIPT_EXTENSIONS.has(NodePath.extname(file))) return [];
  const stem = stripExtension(file);
  return TEST_SUFFIXES.map((suffix) => `${stem}${suffix}`).filter((test) =>
    NodeFS.existsSync(test),
  );
}

/** Vitest browser tests need the Playwright Chromium that `playwright install` downloads. */
function hasPlaywrightChromium(): boolean {
  // The macOS and the Linux cache folder.
  const cacheDirs = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : [
        NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright"),
        NodePath.join(NodeOS.homedir(), ".cache/ms-playwright"),
      ];
  return cacheDirs.some(
    (cacheDir) =>
      NodeFS.existsSync(cacheDir) &&
      NodeFS.readdirSync(cacheDir).some((entry) => entry.startsWith("chromium")),
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function testSteps(): ReadonlyArray<Step> {
  const tests = new Set([
    ...ALWAYS_TESTS.filter((test) => NodeFS.existsSync(test)),
    ...changed.flatMap(testsFor),
  ]);
  for (const [prefix, appTests] of Object.entries(APP_WIDE_TESTS)) {
    if (changed.some((file) => file.startsWith(prefix)))
      for (const test of appTests) tests.add(test);
  }
  const browserTests = [...tests].filter((test) => test.includes(".browser.test."));
  const steps: Array<Step> = [];
  if (browserTests.length > 0 && !hasPlaywrightChromium()) {
    for (const test of browserTests) tests.delete(test);
    steps.push({
      name: "browser tests",
      skipped: `${plural(browserTests.length, "file")}, no Playwright Chromium. Run \`node apps/web/node_modules/playwright/cli.js install --only-shell chromium\``,
    });
  }
  const testsByPackage = Map.groupBy(tests, (test) => packageOf(test));
  for (const [workspace, files] of testsByPackage) {
    if (workspace === undefined || workspace.scripts.test === undefined) {
      steps.push({ name: "test", skipped: `no package test script for ${files.join(", ")}` });
      continue;
    }
    steps.push({
      name: `test ${workspace.name}`,
      detail: plural(files.length, "file"),
      command: [
        "vp",
        "run",
        "--filter",
        workspace.name,
        "test",
        ...files.map((file) => NodePath.relative(workspace.dir, file)),
      ],
    });
  }
  return steps;
}

function steps(): ReadonlyArray<Step> {
  const scripts = changed.filter((file) => SCRIPT_EXTENSIONS.has(NodePath.extname(file)));
  const codeChanged = changed.some(
    (file) => !isDocFile(file) && !file.startsWith("apps/machine-map/"),
  );
  const typecheckPackages = [...new Set(changed.flatMap((file) => packageOf(file) ?? []))].filter(
    (workspace) => workspace.scripts.typecheck !== undefined,
  );
  return [
    changed.length === 0
      ? { name: "format", skipped: "no changed files" }
      : {
          name: "format",
          detail: plural(changed.length, "file"),
          command: ["vp", "fmt", "--check", "--no-error-on-unmatched-pattern", ...changed],
        },
    scripts.length === 0
      ? { name: "lint", skipped: "no changed script files" }
      : {
          name: "lint",
          detail: plural(scripts.length, "file"),
          command: ["vp", "check", "--no-fmt", "--no-error-on-unmatched-pattern", ...scripts],
        },
    codeChanged
      ? { name: "knip", detail: "whole repository", command: ["vp", "run", "knip:check"] }
      : { name: "knip", skipped: "only docs, markdown or apps/machine-map changed, as in Fork CI" },
    typecheckPackages.length === 0
      ? { name: "typecheck", skipped: "no changed package" }
      : {
          name: "typecheck",
          detail: typecheckPackages.map((workspace) => workspace.name).join(", "),
          command: [
            "vp",
            "run",
            ...typecheckPackages.flatMap((workspace) => ["--filter", workspace.name]),
            "typecheck",
          ],
        },
    ...testSteps(),
    {
      name: "doc links",
      detail: "fork docs",
      command: ["node", NodePath.join(import.meta.dirname, "fork-check-doc-links.ts")],
    },
  ];
}

function run(step: Step): Promise<StepResult> {
  if ("skipped" in step) {
    return Promise.resolve({
      name: step.name,
      status: "skipped",
      detail: step.skipped,
      output: "",
    });
  }
  const started = performance.now();
  const [command = "", ...args] = step.command;
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const finish = (status: "pass" | "fail", extra = "") => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      resolve({
        name: step.name,
        status,
        detail: `${step.detail}, ${seconds}s`,
        output: output + extra,
      });
    };
    child.on("error", (error) => finish("fail", `\n${error.message}`));
    child.on("close", (code) => finish(code === 0 ? "pass" : "fail"));
  });
}

console.log(
  `Checking ${plural(changed.length, "changed file")} since ${base.slice(0, 12)} (merge base with origin/main).`,
);
const started = performance.now();
const results = await Promise.all(steps().map(run));

for (const result of results.filter((candidate) => candidate.status === "fail")) {
  console.log(`\n===== ${result.name} failed =====\n${result.output.trimEnd()}`);
}
console.log("");
for (const result of results) {
  console.log(`${result.status.padEnd(8)} ${result.name.padEnd(28)} ${result.detail}`);
}
console.log(
  `\nTotal ${((performance.now() - started) / 1000).toFixed(1)}s. Not covered, Fork CI runs it:`,
);
for (const item of NOT_COVERED) console.log(`- ${item}`);
if (results.some((result) => result.status === "fail")) process.exitCode = 1;
