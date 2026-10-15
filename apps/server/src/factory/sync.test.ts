// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const realScript = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/sync.sh");

const OLD = "v0.0.9-nightly.20261013.1";
const MIDDLE = "v0.0.10-nightly.20261014.2950";
const NEWEST = "v0.0.10-nightly.20261015.3145";
const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";

// Every stub appends its invocation to $SYNC_TEST_LOG and whether GH_TOKEN
// reached it to $SYNC_TEST_LOG.env. `gh` answers the calls
// sync.sh reads from: `pr create` prints a URL, and `issue list` prints the
// number of the issue in $SYNC_TEST_ISSUES whose title is the quoted --search
// text, as the real command does with its --jq filter. `check.sh` fails with
// $SYNC_TEST_CHECK_OUTPUT when set.
const ghStub = `#!/usr/bin/env bash
echo "gh $*" >> "$SYNC_TEST_LOG"
echo "gh \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
for ((i = 1; i <= $#; i++)); do
  j=$((i + 1))
  case "\${!i}" in
    --body-file) cp "\${!j}" "$SYNC_TEST_LOG.body" ;;
    --search) search=\${!j} ;;
  esac
done
case "$1 $2" in
  "pr create") echo "https://example.test/pr/1" ;;
  "issue list")
    node -e '
      const title = process.argv[1].replace(/^"(.*)" in:title$/, "$1");
      const issues = JSON.parse(process.env.SYNC_TEST_ISSUES || "[]");
      const hit = issues.find((issue) => issue.title === title);
      if (hit) console.log(hit.number);
    ' "$search"
    ;;
esac
exit 0
`;

const vpStub = `#!/usr/bin/env bash
echo "vp $*" >> "$SYNC_TEST_LOG"
echo "vp \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
exit 0
`;

const checkStub = `#!/usr/bin/env bash
echo "check.sh" >> "$SYNC_TEST_LOG"
echo "check.sh \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
if [[ -n \${SYNC_TEST_CHECK_OUTPUT:-} ]]; then
  cat "$SYNC_TEST_CHECK_OUTPUT"
  exit 1
fi
echo "check: factory/scripts/check-seams.sh"
exit 0
`;

const regenerateStub = `#!/usr/bin/env bash
echo "regenerate-routes.sh" >> "$SYNC_TEST_LOG"
echo "regenerate-routes.sh \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
echo "regenerated route tree" > "$(git rev-parse --show-toplevel)/${ROUTE_TREE}"
`;

let dir: string;
let upstream: string;
let fork: string;
let origin: string;
let oldSha: string;
let newestSha: string;

const git = (cwd: string, ...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (cwd: string, file: string, content: string, mode = 0o644) => {
  const full = NodePath.join(cwd, file);
  NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
  NodeFS.writeFileSync(full, content, { mode });
};

const commit = (cwd: string, message: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

const initRepo = (cwd: string) => {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "commit.gpgsign", "false");
};

let runs = 0;

// A fresh fork for every test: upstream at OLD plus the factory files, with a
// bare `origin` holding the same main. `upstreamLine` goes into factory/UPSTREAM.
const makeFork = (upstreamLine: string, forkChanges: Record<string, string> = {}) => {
  NodeFS.rmSync(fork, { recursive: true, force: true });
  NodeFS.rmSync(origin, { recursive: true, force: true });
  git(dir, "clone", "-q", "--no-tags", upstream, fork);
  git(fork, "checkout", "-q", oldSha);
  git(fork, "checkout", "-q", "-B", "main");
  git(fork, "config", "user.name", "Test");
  git(fork, "config", "user.email", "test@example.com");
  git(fork, "config", "commit.gpgsign", "false");
  write(fork, "factory/UPSTREAM", `${upstreamLine}\n`);
  write(fork, "factory/scripts/sync.sh", NodeFS.readFileSync(realScript, "utf8"), 0o755);
  write(fork, "factory/scripts/check.sh", checkStub, 0o755);
  write(fork, "factory/scripts/regenerate-routes.sh", regenerateStub, 0o755);
  for (const [file, content] of Object.entries(forkChanges)) write(fork, file, content);
  commit(fork, "factory files");
  git(dir, "init", "-q", "--bare", origin);
  git(fork, "remote", "set-url", "origin", origin);
  git(fork, "push", "-q", "-u", "origin", "main");
};

const run = (env: Record<string, string> = {}) => {
  const log = NodePath.join(dir, `log-${runs++}`);
  const result = NodeChildProcess.spawnSync("bash", ["factory/scripts/sync.sh"], {
    cwd: fork,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${NodePath.join(dir, "bin")}:${process.env.PATH}`,
      SYNC_UPSTREAM: upstream,
      SYNC_TEST_LOG: log,
      GH_TOKEN: "secret",
      ...env,
    },
  });
  const lines = (file: string) =>
    NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").trim().split("\n") : [];
  const calls = lines(log);
  const tokens = lines(`${log}.env`);
  const body = NodeFS.existsSync(`${log}.body`) ? NodeFS.readFileSync(`${log}.body`, "utf8") : "";
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    tokens,
    body,
  };
};

const originBranches = () =>
  git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");

const originFile = (ref: string, file: string) => git(origin, "show", `${ref}:${file}`);

describe("sync.sh", () => {
  beforeAll(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-"));
    upstream = NodePath.join(dir, "upstream");
    fork = NodePath.join(dir, "fork");
    origin = NodePath.join(dir, "origin.git");
    write(dir, "bin/gh", ghStub, 0o755);
    write(dir, "bin/vp", vpStub, 0o755);

    // Three nightly tags whose version order differs from their lexical order,
    // plus a release tag the pattern must skip.
    NodeFS.mkdirSync(upstream);
    initRepo(upstream);
    write(upstream, "README.md", "upstream\n");
    write(upstream, ROUTE_TREE, "routes v9\n");
    write(upstream, "apps/server/src/server.ts", "server v9\n");
    oldSha = commit(upstream, "v9");
    git(upstream, "tag", OLD);
    write(upstream, "README.md", "upstream, later\n");
    write(upstream, ROUTE_TREE, "routes v10\n");
    commit(upstream, "v10 middle");
    git(upstream, "tag", MIDDLE);
    write(upstream, "apps/server/src/server.ts", "server v10\n");
    newestSha = commit(upstream, "v10 newest");
    git(upstream, "tag", "-a", "-m", NEWEST, NEWEST);
    git(upstream, "tag", "v0.0.10");
  });

  afterAll(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("picks the newest nightly tag by version order and stops when UPSTREAM names it", () => {
    makeFork(`${NEWEST} ${newestSha}`);
    const { status, stdout, calls } = run();
    expect(status).toBe(0);
    expect(stdout).toContain(`newest nightly: ${NEWEST}`);
    expect(stdout.trim().split("\n").at(-1)).toBe("up to date");
    expect(calls).toEqual([]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("merges the newest tag, records it, runs the checks and merges the pull request", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, calls, tokens } = run();
    expect(status).toBe(0);
    expect(calls.slice(0, 2)).toEqual(["vp i", "check.sh"]);
    expect(tokens).toEqual(["vp unset", "check.sh unset", "gh secret", "gh secret"]);
    expect(calls[2]).toMatch(
      new RegExp(
        `^gh pr create --base main --head sync/${NEWEST} --title sync: ${NEWEST} --body-file `,
      ),
    );
    expect(calls.slice(3)).toEqual(["gh pr merge https://example.test/pr/1 --merge"]);
    const branch = `sync/${NEWEST}`;
    expect(originBranches()).toEqual(["main", branch]);
    expect(originFile(branch, "factory/UPSTREAM")).toBe(`${NEWEST} ${newestSha}`);
    expect(originFile(branch, "apps/server/src/server.ts")).toBe("server v10");
    expect(originFile(branch, "factory/scripts/check.sh")).toBe(checkStub.trim());
    expect(git(origin, "rev-list", "--count", `main..${branch}`)).toBe("3");
    expect(git(origin, "log", "-1", "--format=%P", branch).split(" ")).toHaveLength(2);
  });

  it("regenerates the route tree when only that file conflicts", () => {
    makeFork(`${OLD} ${oldSha}`, { [ROUTE_TREE]: "routes, fork edit\n" });
    const { status, calls, tokens } = run();
    expect(status).toBe(0);
    expect(calls.slice(0, 3)).toEqual(["vp i", "regenerate-routes.sh", "check.sh"]);
    expect(tokens[1]).toBe("regenerate-routes.sh unset");
    const branch = `sync/${NEWEST}`;
    expect(originFile(branch, ROUTE_TREE)).toBe("regenerated route tree");
    expect(originFile(branch, "factory/UPSTREAM")).toBe(`${NEWEST} ${newestSha}`);
  });

  it("aborts on any other conflict, pushes nothing and opens an issue naming the paths", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n", [ROUTE_TREE]: "fork edit\n" });
    const { status, calls, body } = run();
    expect(status).toBe(1);
    expect(originBranches()).toEqual(["main"]);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(NodeFS.existsSync(NodePath.join(fork, ".git/MERGE_HEAD"))).toBe(false);
    expect(calls.filter((call) => call.startsWith("gh issue list"))).toHaveLength(1);
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} conflicts --body-file `),
    );
    expect(calls).not.toContainEqual(expect.stringMatching(/^(vp|check\.sh|gh pr)/));
    expect(body).toContain("- README.md");
    expect(body).not.toContain(`- ${ROUTE_TREE}`);
  });

  it("comments on the open conflicts issue instead of opening another", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const { status, calls, body } = run({
      SYNC_TEST_ISSUES: JSON.stringify([
        { number: 3, title: `Sync to ${MIDDLE} conflicts` },
        { number: 7, title: `Sync to ${NEWEST} conflicts` },
      ]),
    });
    expect(status).toBe(1);
    expect(calls.at(-1)).toMatch(/^gh issue comment 7 --body-file /);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh issue create/));
    expect(body).toContain("- README.md");
  });

  it("failing checks open a draft pull request and a factory:proposed issue with the failing step", () => {
    makeFork(`${OLD} ${oldSha}`);
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const checkOutput = NodePath.join(dir, "check-output");
    NodeFS.writeFileSync(
      checkOutput,
      [
        "check: factory/scripts/check-seams.sh",
        "seams ok",
        "check: vp test run apps/server/src/factory",
        ...lines,
        "",
      ].join("\n"),
    );
    const { status, calls, body } = run({ SYNC_TEST_CHECK_OUTPUT: checkOutput });
    expect(status).toBe(1);
    expect(originBranches()).toEqual(["main", `sync/${NEWEST}`]);
    expect(calls).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^gh pr create --draft --base main --head sync/${NEWEST} --title sync: ${NEWEST} --body-file `,
        ),
      ),
    );
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh pr merge/));
    expect(calls.at(-1)).toMatch(
      new RegExp(
        `^gh issue create --title Sync to ${NEWEST} fails checks --label factory:proposed --body-file `,
      ),
    );
    expect(body).toContain("`vp test run apps/server/src/factory`");
    expect(body).toContain("https://example.test/pr/1");
    expect(body).toContain("line 51\n");
    expect(body).toContain("line 250\n");
    expect(body).not.toContain("line 50\n");
    expect(body).not.toContain("seams ok");
  });

  it("stops with the merge's own error when the merge fails without a conflict", () => {
    makeFork(`${OLD} ${oldSha}`);
    // An uncommitted edit to a file the tag changes makes git refuse the merge.
    write(fork, "apps/server/src/server.ts", "uncommitted edit\n");
    const { status, stderr, calls } = run();
    expect(status).toBe(1);
    expect(stderr).toContain("sync: git merge");
    expect(stderr).toContain("apps/server/src/server.ts");
    expect(calls).toEqual([]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("stops and says so when the branch cannot be pushed", () => {
    makeFork(`${OLD} ${oldSha}`);
    write(origin, "hooks/pre-receive", "#!/usr/bin/env bash\necho 'refusing' >&2\nexit 1\n", 0o755);
    const { status, stderr, calls } = run();
    expect(status).toBe(1);
    expect(stderr).toContain(`sync: push of sync/${NEWEST} failed`);
    expect(calls).toEqual(["vp i", "check.sh"]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("refuses a tag outside the nightly pattern", () => {
    git(upstream, "tag", 'v0.0.11-nightly."x', newestSha);
    try {
      makeFork(`${OLD} ${oldSha}`);
      const { status, stderr, calls } = run();
      expect(status).toBe(1);
      expect(stderr).toContain("sync: unexpected tag name");
      expect(calls).toEqual([]);
      expect(originBranches()).toEqual(["main"]);
    } finally {
      git(upstream, "tag", "-d", 'v0.0.11-nightly."x');
    }
  });
});
