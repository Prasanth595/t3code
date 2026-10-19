import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId, VcsListRefsInput } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
let directory: string;
let cwd: string;
const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
const branch = { name: "feature/a", current: false, isDefault: false, worktreePath: null };
const environmentId = EnvironmentId.make("branch-test-environment");

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-branch-selection-"));
  cwd = NodePath.join(directory, "project");
  await exec("git", ["init", "-b", "main", cwd]);
  await git("config", "user.name", "Branch test");
  await git("config", "user.email", "branch-test@example.com");
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "main\n");
  await git("add", ".");
  await git("commit", "-m", "main");
  await git("checkout", "-b", branch.name);
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "feature\n");
  await git("commit", "-am", "feature");
  await git("checkout", "main");
});

afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

type CheckoutInput = Parameters<typeof checkoutNewTaskBranch>[0];
const decodeListRefsInput = Schema.decodeUnknownSync(VcsListRefsInput);
const REF_PAGE_SIZE = 2;

const readRefs: CheckoutInput["readRefs"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    const input = decodeListRefsInput(request.input);
    const { stdout } = await exec("git", [
      "-C",
      input.cwd,
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname:short)%09%(worktreepath)",
      "refs/heads",
    ]);
    const refs = stdout
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [name = "", path] = line.split("\t");
        return {
          name,
          current: path === input.cwd,
          isDefault: name === "main",
          isRemote: false,
          worktreePath: path || null,
        };
      })
      .filter((ref) => ref.name.includes(input.query ?? ""));
    const cursor = input.cursor ?? 0;
    return {
      refs: refs.slice(cursor, cursor + REF_PAGE_SIZE),
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: cursor + REF_PAGE_SIZE < refs.length ? cursor + REF_PAGE_SIZE : null,
      totalCount: refs.length,
    };
  });

const refuseSwitch: CheckoutInput["switchRef"] = () => {
  throw new Error("An occupied branch must not trigger checkout");
};

function selectBranch(switchRef: CheckoutInput["switchRef"]) {
  return checkoutNewTaskBranch({
    branch,
    project: { environmentId, workspaceRoot: cwd },
    workspaceMode: "local",
    readRefs,
    switchRef,
  });
}

const switchRef: CheckoutInput["switchRef"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    await exec("git", ["-C", request.input.cwd, "checkout", request.input.refName]);
    const { stdout } = await exec("git", ["-C", request.input.cwd, "branch", "--show-current"]);
    return { refName: stdout.trim() };
  });

describe("new-task branch checkout", () => {
  it("switches main to the older thread's feature branch before returning a selection", async () => {
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Checkout failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.current).toBe(true);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe("feature\n");
  });

  it("does not release the selection while checkout is still pending", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let completed = false;
    const selection = selectBranch(async (request) => {
      entered.resolve();
      await release.promise;
      return switchRef(request);
    }).then((result) => {
      completed = true;
      return result;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    release.resolve();
    expect((await selection)._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
  });

  it("returns checkout failure without selecting the branch or losing dirty files", async () => {
    await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "unsaved local changes\n");
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected checkout to fail");
    expect(String(squashAtomCommandFailure(result))).toContain("would be overwritten");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe(
      "unsaved local changes\n",
    );
  });

  it("fails when the source project is unavailable instead of releasing a composer selection", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: null,
      workspaceMode: "local",
      readRefs,
      switchRef: () => {
        throw new Error("An unavailable project must not run checkout");
      },
    });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected an unavailable-project failure");
    expect(String(squashAtomCommandFailure(result))).toContain("selected project is unavailable");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("reuses an existing worktree without switching the project checkout", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: () => {
        throw new Error("Existing worktrees must not switch the project checkout");
      },
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Worktree selection failed");
    expect(result.value.worktreePath).toBe(worktreePath);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
  });

  it("resolves historical branch metadata to its worktree beyond a long query's first page", async () => {
    const name = `feature/${"a".repeat(120)}/${"b".repeat(150)}`;
    await git("branch", "-m", branch.name, name);
    await git("branch", `a-${name}`);
    await git("branch", `b-${name}`);
    await git("worktree", "add", NodePath.join(directory, "decoy"), `a-${name}`);
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, name);

    const result = await checkoutNewTaskBranch({
      branch: { ...branch, name },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Historical branch selection failed");
    expect(result.value).toMatchObject({
      name,
      worktreePath: await NodeFSP.realpath(worktreePath),
    });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe("main\n");
  });

  it("resolves a non-origin remote to the right worktree when the remote name contains slashes", async () => {
    await git("branch", "upstream/feature/a");
    await git("worktree", "add", NodePath.join(directory, "decoy"), "upstream/feature/a");
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, branch.name);

    const result = await checkoutNewTaskBranch({
      branch: {
        ...branch,
        name: "team/upstream/feature/a",
        isRemote: true,
        remoteName: "team/upstream",
      },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Remote branch selection failed");
    expect(result.value).toMatchObject({
      name: branch.name,
      isRemote: false,
      worktreePath: await NodeFSP.realpath(worktreePath),
    });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("skips checkout when historical metadata names the already-current branch", async () => {
    await git("checkout", branch.name);

    const result = await selectBranch(refuseSwitch);

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Current branch selection failed");
    expect(result.value).toMatchObject({ name: branch.name, current: true });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe(branch.name);
  });
});
