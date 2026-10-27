// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files.
const fixtureConfig = {
  "core.excludesFile": NodeOS.devNull,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    for (const file of ["scripts/check-changed.ts", ".github/scripts/ci-changes.cjs"]) {
      write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
    }
    write(".gitignore", "bin/\n");
    write("pnpm-workspace.yaml", "packages: []\n");
    write(
      "package.json",
      JSON.stringify({ type: "module", scripts: { "knip:check": "knip --include files" } }),
    );
    write("bin/vp", "#!/bin/sh\nexit 0\n");
    NodeFS.chmodSync(NodePath.join(root, "bin/vp"), 0o755);
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      if (name !== "A") write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    run: (...args: Array<string>) =>
      NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}` },
      }),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = project.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `1 files since ${project.commits.B!.slice(0, 12)} (${remote}/main)`,
    );
  },
);

it("compares against an explicit ref instead of the closest remote main", () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = project.run("origin/main");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain(`2 files since ${project.commits.A!.slice(0, 12)} (origin/main)`);
});
