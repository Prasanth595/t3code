// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const realScript = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/check.sh");

const SEAMS = "seams";
const TEST = "vp test run apps/server/src/factory";
const SERVER_TYPECHECK = "vp run --filter t3 typecheck";
const WEB_TYPECHECK = "vp run --filter @t3tools/web typecheck";

// Both stubs append their invocation to $CHECK_TEST_LOG, then exit with the code
// from $CHECK_TEST_FAIL ("<invocation>=<code>") when it names this invocation.
const stub = (invocation: string) => `#!/usr/bin/env bash
invocation=${invocation}
echo "$invocation" >> "$CHECK_TEST_LOG"
case "\${CHECK_TEST_FAIL:-}" in
  "$invocation="*) exit "\${CHECK_TEST_FAIL##*=}" ;;
esac
exit 0
`;

let root: string;
let script: string;

const write = (file: string, content: string) => {
  const full = NodePath.join(root, file);
  NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
  NodeFS.writeFileSync(full, content, { mode: 0o755 });
};

let runs = 0;

const run = (fail?: string) => {
  const log = NodePath.join(root, `log-${runs++}`);
  const result = NodeChildProcess.spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}`,
      CHECK_TEST_LOG: log,
      CHECK_TEST_FAIL: fail ?? "",
    },
  });
  const calls = NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: result.status, stdout: result.stdout, calls };
};

describe("check.sh", () => {
  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-"));
    script = NodePath.join(root, "factory/scripts/check.sh");
    write("factory/scripts/check.sh", NodeFS.readFileSync(realScript, "utf8"));
    write("factory/scripts/check-seams.sh", stub(SEAMS));
    write(
      "bin/vp",
      `#!/usr/bin/env bash
invocation="vp $*"
echo "$invocation" >> "$CHECK_TEST_LOG"
case "\${CHECK_TEST_FAIL:-}" in
  "$invocation="*) exit "\${CHECK_TEST_FAIL##*=}" ;;
esac
exit 0
`,
    );
  });

  afterAll(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("runs every step in order and exits 0", () => {
    const { status, stdout, calls } = run();
    expect(status).toBe(0);
    expect(calls).toEqual([
      SEAMS,
      `vp ${TEST.slice(3)}`,
      `vp ${SERVER_TYPECHECK.slice(3)}`,
      `vp ${WEB_TYPECHECK.slice(3)}`,
    ]);
    const at = ["factory/scripts/check-seams.sh", TEST, SERVER_TYPECHECK, WEB_TYPECHECK].map(
      (name) => stdout.indexOf(name),
    );
    expect(at[0]).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(new Set(at).size).toBe(4);
  });

  it("stops at the first failure with that command's exit code", () => {
    const { status, stdout, calls } = run(`vp ${SERVER_TYPECHECK.slice(3)}=3`);
    expect(status).toBe(3);
    expect(calls).toEqual([SEAMS, `vp ${TEST.slice(3)}`, `vp ${SERVER_TYPECHECK.slice(3)}`]);
    expect(stdout).toContain(SERVER_TYPECHECK);
    expect(stdout).not.toContain(WEB_TYPECHECK);
  });

  it("a failing seam check stops before any vp command", () => {
    const { status, calls } = run(`${SEAMS}=2`);
    expect(status).toBe(2);
    expect(calls).toEqual([SEAMS]);
  });
});
