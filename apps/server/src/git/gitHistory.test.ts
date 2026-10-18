import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { readGitHistory } from "./gitHistory.ts";

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-history-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-history-repo-" });
  const git = yield* GitVcsDriver.GitVcsDriver;
  const run = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "test.history", cwd, args });
  const commit = (subject: string) =>
    run([
      "-c",
      "user.name=Graph Author",
      "-c",
      "user.email=graph@test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      subject,
    ]);
  yield* run(["init", "-b", "main"]);
  const history = (headBranch = "feature", baseBranch = "main") =>
    readGitHistory(git, { cwd, headBranch, baseBranch });
  return { cwd, run, commit, history };
});
const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | GitVcsDriver.GitVcsDriver | import("effect/Scope").Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("git branch history", () => {
  it.effect("reads real merge parents and branch labels without changing the checkout", () =>
    provide(
      Effect.gen(function* () {
        const { run, commit, history } = yield* fixture;
        yield* commit("root");
        yield* run(["switch", "-c", "feature"]);
        yield* commit("head subject, with unicode → and separator \u001f");
        yield* run(["switch", "main"]);
        yield* commit("base advanced");
        yield* run(["switch", "feature"]);
        yield* run([
          "-c",
          "user.name=Graph Author",
          "-c",
          "user.email=graph@test",
          "-c",
          "commit.gpgsign=false",
          "merge",
          "--no-ff",
          "main",
          "-m",
          "Merge main",
        ]);
        const before = yield* run(["status", "--porcelain=v1", "--branch"]);
        const result = yield* history();
        expect(result.commits).toHaveLength(4);
        expect(result.commits[0]?.parents).toHaveLength(2);
        expect(result.commits[0]?.sha).toBe(result.headSha);
        expect(result.commits.find((entry) => entry.sha === result.baseSha)?.branches).toContain(
          "main",
        );
        expect(
          result.commits.find((entry) => entry.subject.startsWith("head subject"))?.author,
        ).toBe("Graph Author");
        expect(
          result.commits.find((entry) => entry.subject.startsWith("head subject"))?.subject,
        ).toContain("\u001f");
        expect((yield* run(["status", "--porcelain=v1", "--branch"])).stdout).toBe(before.stdout);
      }),
    ),
  );
  it.effect("returns an empty graph for unborn and unavailable branches", () =>
    provide(
      Effect.gen(function* () {
        const { commit, history } = yield* fixture;
        expect((yield* history()).commits).toEqual([]);
        yield* commit("root");
        expect((yield* history("not-checked-out")).headSha).toBeNull();
      }),
    ),
  );
  it.effect("uses remote base tips before stale local branches and accepts remote-only heads", () =>
    provide(
      Effect.gen(function* () {
        const { run, commit, history } = yield* fixture;
        yield* commit("root");
        yield* run(["switch", "-c", "feature"]);
        yield* commit("remote head");
        yield* run(["update-ref", "refs/remotes/origin/feature", "HEAD"]);
        yield* run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        yield* run(["switch", "main"]);
        yield* run(["branch", "-D", "feature"]);
        const result = yield* history();
        expect(result.headSha).toBe(result.baseSha);
        expect(result.commits[0]?.subject).toBe("remote head");
      }),
    ),
  );
  it.effect("bounds history and excludes checkpoint refs", () =>
    provide(
      Effect.gen(function* () {
        const { run, commit, history } = yield* fixture;
        yield* commit("root");
        yield* run(["switch", "-c", "feature"]);
        for (let i = 0; i < 42; i++) yield* commit(`commit ${i}`);
        yield* run(["update-ref", "refs/t3/checkpoints/private", "HEAD"]);
        const result = yield* history();
        expect(result.commits).toHaveLength(40);
        expect(result.truncated).toBe(true);
        expect(result.commits.flatMap((entry) => entry.branches)).not.toContain(
          "refs/t3/checkpoints/private",
        );
      }),
    ),
  );
  it.effect("keeps an older local head when many newer remote refs match the base branch", () =>
    provide(
      Effect.gen(function* () {
        const { cwd, run, commit, history } = yield* fixture;
        yield* commit("local head");
        yield* run(["branch", "feature"]);
        const localHead = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
        const git = yield* GitVcsDriver.GitVcsDriver;
        yield* git.execute({
          operation: "test.history",
          cwd,
          args: [
            "-c",
            "user.name=Graph Author",
            "-c",
            "user.email=graph@test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "newer remote base",
          ],
          env: { GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" },
        });
        yield* git.execute({
          operation: "test.history",
          cwd,
          args: ["update-ref", "--stdin"],
          stdin: Array.from(
            { length: 70 },
            (_, index) => `update refs/remotes/remote-${index}/main HEAD\n`,
          ).join(""),
        });
        const result = yield* history();
        expect(result.headSha).toBe(localHead);
        expect(result.commits.some((entry) => entry.sha === localHead)).toBe(true);
        expect(result.commits.find((entry) => entry.sha === localHead)?.branches).toContain(
          "feature",
        );
      }),
    ),
  );
  it.effect("rejects revision expressions and wildcard patterns", () =>
    provide(
      Effect.gen(function* () {
        const { history } = yield* fixture;
        for (const ref of ["main~1", "feature/*", "--all", "main..feature"]) {
          const result = yield* history(ref).pipe(Effect.result);
          // A flag-shaped ref cannot become a git log argument; no matching branch yields no history.
          if (ref === "--all")
            expect(result._tag === "Failure" || result.success.headSha === null).toBe(true);
          else expect(result._tag).toBe("Failure");
        }
      }),
    ),
  );
});
