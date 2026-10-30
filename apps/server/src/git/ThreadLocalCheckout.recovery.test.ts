import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitCommandError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ThreadLocalCheckout from "./ThreadLocalCheckout.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

// These need folders that differ only by case, which the default volumes on Windows and macOS
// can't hold; Linux runs them, and the code is the same on every platform.
const caseFoldingHost = ["win32", "darwin"].includes(HostProcess.Platform.defaultValue());

const threadId = ThreadId.make("thread-move-to-local");
const projectId = ProjectId.make("project-move-to-local");

interface OtherThread {
  readonly id: string;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly archived?: boolean;
  readonly running?: boolean;
}

interface Fixture {
  readonly root: string;
  readonly local: string;
  readonly worktree: string;
  readonly git: (
    cwd: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, GitCommandError>;
}

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "move-to-local-recovery-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A repo on `main` with `feature` checked out in a linked worktree one commit ahead. */
const makeFixture = Effect.fn("makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  // Canonical, as the move resolves paths: macOS temp folders sit behind the /var symlink.
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({
      prefix: "fixture-",
    }),
  );
  const local = `${root}/repo`;
  const worktree = `${root}/worktrees/feature`;
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "move-to-local-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* fs.makeDirectory(local, { recursive: true });
  yield* git(local, ["init", "-b", "main"]);
  yield* git(local, ["config", "user.name", "Test"]);
  yield* git(local, ["config", "user.email", "test@example.test"]);
  yield* fs.writeFileString(`${local}/shared.txt`, "base\n");
  yield* fs.writeFileString(`${local}/.gitignore`, "ignored/\n");
  yield* git(local, ["add", "."]);
  yield* git(local, ["commit", "-m", "base"]);
  yield* git(local, ["worktree", "add", "-b", "feature", worktree]);
  yield* fs.writeFileString(`${worktree}/feature.txt`, "feature\n");
  yield* git(worktree, ["add", "feature.txt"]);
  yield* git(worktree, ["commit", "-m", "feature work"]);
  return { root, local, worktree, git } satisfies Fixture;
});

interface HarnessOptions {
  readonly fixture: Fixture;
  readonly threadBranch?: string | null;
  readonly threadWorktreePath?: string | null;
  readonly selfRunning?: boolean;
  readonly others?: ReadonlyArray<OtherThread>;
  readonly dispatchFails?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
}

const makeHarness = (options: HarnessOptions) => {
  const { fixture } = options;
  const thread = {
    id: threadId,
    projectId,
    title: "Moving thread",
    branch: options.threadBranch === undefined ? "feature" : options.threadBranch,
    worktreePath:
      options.threadWorktreePath === undefined ? fixture.worktree : options.threadWorktreePath,
    archivedAt: null,
    deletedAt: null,
  };
  const shell = (
    id: string,
    title: string,
    worktreePath: string | null,
    archived: boolean,
    running: boolean,
  ) =>
    ({
      id: ThreadId.make(id),
      projectId,
      title,
      worktreePath,
      archivedAt: archived ? DateTime.makeUnsafe(0) : null,
      activeRunId: running ? "run-active" : null,
    }) as unknown as OrchestrationV2ThreadShell;
  const shells = () => [
    shell(threadId, thread.title, thread.worktreePath, false, options.selfRunning ?? false),
    ...(options.others ?? []).map((other) =>
      shell(
        other.id,
        other.title,
        other.worktreePath,
        other.archived ?? false,
        other.running ?? false,
      ),
    ),
  ];

  const dispatch = vi.fn((command: { readonly worktreePath?: string | null }) =>
    (options.dispatchGate ?? Effect.void).pipe(
      Effect.andThen(
        options.dispatchFails
          ? Effect.fail(
              new OrchestratorDispatchError({
                commandId: "command-test" as never,
                commandType: "thread.metadata.update",
                cause: "worktree changed",
              }),
            )
          : Effect.sync(() => {
              thread.worktreePath = command.worktreePath ?? null;
              return {} as never;
            }),
      ),
    ),
  );

  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({ thread: { ...thread } } as unknown as OrchestrationV2ThreadProjection),
      listProjectThreads: () => Effect.succeed(shells().filter((item) => item.archivedAt === null)),
      getShellSnapshot: (snapshotOptions) =>
        Effect.succeed({
          threads:
            snapshotOptions?.location === "archive"
              ? []
              : shells().filter((item) => item.archivedAt === null),
          archivedThreads: shells().filter((item) => item.archivedAt !== null),
        } as never),
      dispatch: dispatch as never,
    } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Project",
          workspaceRoot: fixture.local,
          scripts: [],
        } as unknown as Project),
    } satisfies Partial<ProjectService.ProjectService["Service"]>),
    Layer.effect(GitWorkflowService.GitWorkflowService)(
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        return GitWorkflowService.GitWorkflowService.of({
          isRepository: () => Effect.succeed(true),
          removeWorktree: (input: {
            readonly cwd: string;
            readonly path: string;
            readonly force?: boolean;
          }) =>
            driver
              .execute({
                operation: "test.removeWorktree",
                cwd: input.cwd,
                args: ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path],
              })
              .pipe(Effect.asVoid),
          invalidateStatus: () => Effect.void,
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]);
      }),
    ),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.void as never,
    } satisfies Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>),
  );

  const move = (input: Partial<ThreadLocalCheckout.MoveThreadToLocalCheckoutInput> = {}) =>
    ThreadLocalCheckout.moveThreadToLocalCheckout({ threadId, ...input }).pipe(
      Effect.provide(layer),
    );

  const preview = () =>
    ThreadLocalCheckout.previewMoveThreadToLocalCheckout({ threadId }).pipe(Effect.provide(layer));

  return { thread, dispatch, move, preview };
};

const expectCode = (exit: Exit.Exit<unknown, unknown>, code: string) => {
  if (!Exit.isFailure(exit)) expect.fail(`Expected failure ${code}, got success`);
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") expect.fail(`Expected a typed failure, got ${reason?._tag}`);
  expect(reason.error).toMatchObject({ _tag: "ThreadMoveToLocalCheckoutError", code });
};

const currentBranch = (fixture: Fixture, cwd: string) =>
  fixture.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

const journalFile = (fixture: Fixture) =>
  `${fixture.local}/.git/t3-move-to-local/pending/${encodeURIComponent(threadId)}.json`;

/** Leaves the repositories as a move leaves them when the server dies after copying files. */
const simulateCrashAfterCopy = Effect.fn("simulateCrashAfterCopy")(function* (fixture: Fixture) {
  const fs = yield* FileSystem.FileSystem;
  const snapshot = yield* fixture.git(fixture.worktree, ["stash", "create"]);
  const worktreeHead = yield* fixture.git(fixture.worktree, ["rev-parse", "HEAD"]);
  const localHead = yield* fixture.git(fixture.local, ["rev-parse", "HEAD"]);
  yield* fs.makeDirectory(`${fixture.local}/.git/t3-move-to-local/pending`, { recursive: true });
  yield* fs.writeFileString(
    journalFile(fixture),
    JSON.stringify({
      version: 2,
      localRoot: fixture.local,
      localGitDir: `${fixture.local}/.git`,
      worktreePath: fixture.worktree,
      sourceRoot: fixture.worktree,
      branch: "feature",
      branchHead: worktreeHead,
      previousLocalBranch: "main",
      previousLocalHead: localHead,
      worktreeHead,
      snapshot: snapshot.length > 0 ? snapshot : null,
      untracked: ["new.txt"],
    }),
  );
  yield* fixture.git(fixture.worktree, ["switch", "--detach", "--quiet"]);
  yield* fixture.git(fixture.local, ["switch", "--quiet", "feature"]);
  if (snapshot.length > 0) {
    yield* fixture.git(fixture.local, ["stash", "apply", "--index", snapshot]);
  }
  yield* fs.writeFileString(
    `${fixture.local}/new.txt`,
    yield* fs.readFileString(`${fixture.worktree}/new.txt`),
  );
});

const instrument = Effect.fn(function* (
  intercept: (
    input: GitVcsDriver.ExecuteGitInput,
    execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  ) => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return {
    ...driver,
    execute: (input: GitVcsDriver.ExecuteGitInput) =>
      Effect.suspend(() => intercept(input, driver.execute)),
  };
});
const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? String((exit.cause.reasons[0].error as { message: string }).message)
    : "";

describe("rollback and recovery safety", () => {
  it.effect(
    "rollback preserves a user's staged content when the working file equals the old commit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        const operations: string[] = [];
        const driver = yield* instrument((input, execute) => {
          operations.push(input.operation);
          return execute(input).pipe(
            Effect.tap(() =>
              input.operation === "ThreadLocalCheckout.switchLocal"
                ? Effect.gen(function* () {
                    yield* fs.writeFileString(
                      `${f.local}/shared.txt`,
                      "unique staged user content\n",
                    );
                    yield* f.git(f.local, ["add", "shared.txt"]);
                    yield* fs.writeFileString(`${f.local}/shared.txt`, "base\n");
                  }).pipe(Effect.orDie)
                : Effect.void,
            ),
          );
        });
        const exit = yield* Effect.exit(
          makeHarness({ fixture: f })
            .move()
            .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
        );
        expectCode(exit, "operation_failed");
        expect({
          index: yield* f.git(f.local, ["show", ":shared.txt"]),
          working: yield* fs.readFileString(`${f.local}/shared.txt`),
          forced: operations.includes("ThreadLocalCheckout.forceRestoreLocal"),
          savedRecovery: operations.includes("ThreadLocalCheckout.recoveryCommit"),
        }).toEqual({
          index: "unique staged user content",
          working: "base\n",
          forced: false,
          savedRecovery: false,
        });
      }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("rollback keeps an edit it can't read instead of forcing the checkout back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const operations: string[] = [];
      const driver = yield* instrument((input, execute) => {
        operations.push(input.operation);
        if (input.operation === "ThreadLocalCheckout.hashFiles") {
          return Effect.fail(
            new GitCommandError({
              operation: input.operation,
              cwd: input.cwd,
              detail: "transient sharing violation",
              command: "git hash-object",
            }),
          );
        }
        return execute(input).pipe(
          Effect.tap(() =>
            input.operation === "ThreadLocalCheckout.switchLocal"
              ? fs
                  .writeFileString(`${f.local}/shared.txt`, "unique uncommitted user content\n")
                  .pipe(Effect.orDie)
              : Effect.void,
          ),
        );
      });
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f })
          .move()
          .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
      );
      expectCode(exit, "operation_failed");
      expect({
        working: yield* fs.readFileString(`${f.local}/shared.txt`),
        forced: operations.includes("ThreadLocalCheckout.forceRestoreLocal"),
      }).toEqual({ working: "unique uncommitted user content\n", forced: false });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("recovery refuses a busy local checkout before changing its branch or files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
      yield* simulateCrashAfterCopy(f);
      const exit = yield* Effect.exit(
        makeHarness({
          fixture: f,
          others: [
            {
              id: "running-local",
              title: "Busy local",
              worktreePath: null,
              running: true,
            },
          ],
        }).move(),
      );
      expectCode(exit, "local_checkout_busy");
      expect({
        branch: yield* currentBranch(f, f.local),
        fileStillHere: yield* fs.exists(`${f.local}/new.txt`),
        journalRetained: yield* fs.exists(journalFile(f)),
      }).toEqual({ branch: "feature", fileStillHere: true, journalRetained: true });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect.each(["local", "worktree"] as const)(
    "recovery refuses an unfinished merge in the %s checkout",
    (checkout) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
        yield* simulateCrashAfterCopy(f);
        const marker = yield* f.git(f[checkout], ["rev-parse", "--absolute-git-dir"]);
        const markerPath = `${marker}/MERGE_HEAD`;
        const head = yield* f.git(f[checkout], ["rev-parse", "HEAD"]);
        yield* fs.writeFileString(markerPath, `${head}\n`);
        const before = yield* fs.readFileString(journalFile(f));

        expectCode(
          yield* Effect.exit(makeHarness({ fixture: f }).move()),
          checkout === "local" ? "local_operation_in_progress" : "worktree_operation_in_progress",
        );
        expect(yield* currentBranch(f, f.local)).toBe("feature");
        expect(yield* currentBranch(f, f.worktree)).toBe("HEAD");
        expect(yield* fs.readFileString(`${f.local}/new.txt`)).toBe("new file\n");
        expect(yield* fs.readFileString(journalFile(f))).toBe(before);
        expect(yield* fs.readFileString(markerPath)).toBe(`${head}\n`);
      }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("recovery leaves a handed-off detached worktree alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
      yield* simulateCrashAfterCopy(f);
      const exit = yield* Effect.exit(
        makeHarness({
          fixture: f,
          others: [
            {
              id: "worktree-owner",
              title: "New owner",
              worktreePath: f.worktree,
            },
          ],
        }).move(),
      );
      expectCode(exit, "worktree_shared");
      expect({
        sourceBranch: yield* currentBranch(f, f.worktree),
        localBranch: yield* currentBranch(f, f.local),
      }).toEqual({ sourceBranch: "HEAD", localBranch: "feature" });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("recovers and moves tracked and untracked changes after a crash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried\n");
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
      yield* simulateCrashAfterCopy(f);
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      expect(exit._tag, failureMessage(exit)).toBe("Success");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("preview does not refresh either git index on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.utimes(`${f.local}/shared.txt`, 1_600_000_000, 1_600_000_000);
      const before = yield* fs.readFile(`${f.local}/.git/index`);
      const preview = yield* makeHarness({ fixture: f }).preview();
      expect(preview.blocker).toBeNull();
      const after = yield* fs.readFile(`${f.local}/.git/index`);
      expect({
        indexBytesUnchanged:
          before.every((byte, i) => byte === after[i]) && before.length === after.length,
      }).toEqual({ indexBytesUnchanged: true });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect.skipIf(caseFoldingHost)(
    "a case-sensitive macOS volume permits distinct checkout paths differing by case",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const upper = `${f.root}/REPO`;
        yield* f.git(f.local, ["worktree", "move", f.worktree, upper]);
        const preview = yield* makeHarness({ fixture: { ...f, worktree: upper } })
          .preview()
          .pipe(Effect.provideService(HostProcess.Platform, "darwin"));
        expect({ blocker: preview.blocker, branch: preview.branch }).toEqual({
          blocker: null,
          branch: "feature",
        });
      }).pipe(Effect.provide(gitLayer)),
  );
});

describe("journal identity and preview", () => {
  it.effect("recovery does not apply another destination checkout's journal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
      yield* simulateCrashAfterCopy(f);
      // The user repaired the old destination, then made a different local checkout.
      yield* f.git(f.local, ["switch", "--quiet", "-c", "manual"]);
      const otherLocal = `${f.root}/other-local`;
      yield* f.git(f.local, ["worktree", "add", otherLocal, "feature"]);
      yield* fs.writeFileString(`${otherLocal}/new.txt`, "new file\n");
      yield* fs.writeFileString(`${otherLocal}/shared.txt`, "unique edit in new destination\n");
      const original = makeHarness({ fixture: { ...f, local: otherLocal } });
      const exit = yield* Effect.exit(original.move());
      expectCode(exit, "operation_failed");
      expect(JSON.stringify(exit)).toContain("isn't this project's checkout");
      expect({
        otherBranch: yield* currentBranch(f, otherLocal),
        unrelatedCopyExists: yield* fs.exists(`${otherLocal}/new.txt`),
        originalBranch: yield* currentBranch(f, f.local),
      }).toEqual({ otherBranch: "feature", unrelatedCopyExists: true, originalBranch: "manual" });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("preview with tracked changes writes no snapshot, journal or index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "staged\n");
      yield* f.git(f.worktree, ["add", "shared.txt"]);
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "unstaged after staged\n");
      const sourceIndex = yield* f.git(f.worktree, ["rev-parse", "--git-path", "index"]);
      const before = yield* fs.readFile(sourceIndex);
      const operations: string[] = [];
      const driver = yield* instrument((input, execute) => {
        operations.push(input.operation);
        return execute(input);
      });
      const preview = yield* makeHarness({ fixture: f })
        .preview()
        .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      expect(preview).toMatchObject({
        blocker: null,
        changes: { staged: 1, unstaged: 1, untracked: 0 },
      });
      expect(operations).not.toContain("ThreadLocalCheckout.snapshot");
      expect(yield* fs.exists(journalFile(f))).toBe(false);
      expect(Array.from(yield* fs.readFile(sourceIndex))).toEqual(Array.from(before));
      expect(yield* currentBranch(f, f.local)).toBe("main");
      expect(yield* currentBranch(f, f.worktree)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("interrupted preview preserves journal, files and both HEADs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried\n");
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
      yield* simulateCrashAfterCopy(f);
      const before = yield* fs.readFileString(journalFile(f));
      const operations: string[] = [];
      const driver = yield* instrument((input, execute) => {
        operations.push(input.operation);
        return execute(input);
      });
      const preview = yield* makeHarness({ fixture: f })
        .preview()
        .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      expect(preview).toMatchObject({ interruptedMove: true, blocker: null });
      expect(yield* fs.readFileString(journalFile(f))).toBe(before);
      expect(yield* fs.readFileString(`${f.local}/shared.txt`)).toBe("carried\n");
      expect(yield* fs.readFileString(`${f.local}/new.txt`)).toBe("new file\n");
      expect(yield* currentBranch(f, f.local)).toBe("feature");
      expect(yield* currentBranch(f, f.worktree)).toBe("HEAD");
      expect(operations.some((name) => /snapshot|recoverLocal|recoverWorktree/i.test(name))).toBe(
        false,
      );
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("case-sensitive volumes", () => {
  it.effect.skipIf(caseFoldingHost)(
    "case-insensitive containment does not permit a copy into a distinct sibling root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        const peer = `${f.root}/REPO`;
        yield* fs.makeDirectory(`${peer}/sub`, { recursive: true });
        yield* fs.makeDirectory(`${f.worktree}/sub`);
        yield* fs.writeFileString(`${f.worktree}/sub/new.txt`, "carried new file\n");
        const racingFs = {
          ...fs,
          open: ((target: string, options: Parameters<typeof fs.open>[1]) =>
            (target === `${f.local}/sub/new.txt`
              ? fs
                  .rename(`${f.local}/sub`, `${f.local}/sub-original`)
                  .pipe(Effect.andThen(fs.symlink(`${peer}/sub`, `${f.local}/sub`)))
              : Effect.void
            ).pipe(Effect.andThen(fs.open(target, options)))) as typeof fs.open,
        };
        const exit = yield* Effect.exit(
          makeHarness({ fixture: f })
            .move()
            .pipe(
              Effect.provideService(HostProcess.Platform, "darwin"),
              Effect.provideService(FileSystem.FileSystem, racingFs),
            ),
        );
        expect({
          outcome: exit._tag,
          fileWrittenOutsideCheckout: yield* fs.exists(`${peer}/sub/new.txt`),
        }).toEqual({ outcome: "Failure", fileWrittenOutsideCheckout: false });
      }).pipe(Effect.provide(gitLayer)),
  );
});

describe("a corrupt journal", () => {
  it.effect("a corrupt pending journal blocks a detached source without executing recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new file\n");
      yield* simulateCrashAfterCopy(f);
      const broken = '{"version":1,"worktreePath":';
      yield* fs.writeFileString(journalFile(f), broken);
      const h = makeHarness({ fixture: f });
      const preview = yield* h.preview();
      expect(preview).toMatchObject({
        interruptedMove: false,
        blocker: { code: "worktree_detached" },
      });
      expectCode(yield* Effect.exit(h.move()), "worktree_detached");
      expect(yield* fs.readFileString(journalFile(f))).toBe(broken);
      expect(yield* currentBranch(f, f.local)).toBe("feature");
      expect(yield* currentBranch(f, f.worktree)).toBe("HEAD");
      expect(yield* fs.readFileString(`${f.local}/new.txt`)).toBe("new file\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});
