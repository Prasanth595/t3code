// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../../../factory/scripts/check-seams.sh");

let repo: string;

const git = (...args: Array<string>) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (file: string, content: string) => {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const runScript = () => {
  const result = spawnSync("bash", [script], { cwd: repo, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe("check-seams.sh", () => {
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "check-seams-"));
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write("apps/server/src/server.ts", "base\n");
    write("apps/server/src/ws.ts", "base\n");
    commit("base");
    const base = git("rev-parse", "HEAD");
    write("factory/UPSTREAM", `v0.0.0-test ${base}\n`);
    write("factory/SEAMS", "apps/server/src/server.ts\n");
    commit("factory metadata");
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("passes when every change is allowed or a listed seam", () => {
    write("apps/server/src/server.ts", "changed\n");
    write("apps/server/src/factory/index.ts", "x\n");
    write(".dw/config.yml", "x: 1\n");
    write("apps/web/src/routes/factory.tsx", "x\n");
    write(".github/workflows/factory-ci.yml", "x: 1\n");
    commit("allowed changes");

    const { status, output } = runScript();
    expect(output).not.toContain("not a listed seam");
    expect(status).toBe(0);
  });

  it("fails and names an unlisted upstream change", () => {
    write("apps/server/src/ws.ts", "changed\n");
    commit("unlisted change");

    const { status, output } = runScript();
    expect(status).toBe(1);
    expect(output).toContain("apps/server/src/ws.ts");
    expect(output).not.toContain("apps/server/src/server.ts");
  });
});
