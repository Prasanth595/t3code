import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEnvironmentManager,
  EnvironmentManagerError,
  type EnvironmentBackend,
  type EnvironmentIdentity,
  type ManagedEnvironment,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-environment-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspaces", "repo", "worktree-a");
  await mkdir(workspace, { recursive: true });
  return {
    request: {
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      storageRoot: path.join(root, "workspaces"),
      worktreePath: workspace,
    },
    root,
    workspace,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeBackend implements EnvironmentBackend {
  readonly id = "fake";
  readonly calls: string[] = [];
  readonly records = new Map<string, ManagedEnvironment>();
  mismatch = false;
  failStart = false;

  async inspect(identity: EnvironmentIdentity) {
    this.calls.push("inspect");
    const record = this.records.get(identity.id);
    return record ? (this.mismatch ? { ...record, ownerId: "other-owner" } : record) : null;
  }

  async create(identity: EnvironmentIdentity) {
    this.calls.push("create");
    const record: ManagedEnvironment = {
      ...identity,
      backendId: this.id,
      resourceId: `resource-${identity.id}`,
      status: "stopped",
    };
    this.records.set(record.id, record);
    return record;
  }

  async start(environment: ManagedEnvironment) {
    this.calls.push("start");
    if (this.failStart) throw new Error("daemon unavailable");
    const record = { ...environment, status: "ready" as const };
    this.records.set(record.id, record);
    return record;
  }

  async stop(environment: ManagedEnvironment) {
    this.calls.push("stop");
    const record = { ...environment, status: "stopped" as const };
    this.records.set(record.id, record);
    return record;
  }

  async remove(environment: ManagedEnvironment) {
    this.calls.push("remove");
    this.records.delete(environment.id);
  }
}

describe("environment lifecycle coordinator", () => {
  test("derives a stable owner and worktree scoped identity", async () => {
    const { request } = await fixture();
    const manager = createEnvironmentManager(new FakeBackend());

    const first = await manager.identity(request);
    const second = await manager.identity({ ...request, worktreePath: path.join(request.storageRoot, "repo", ".", "worktree-a") });

    expect(first.id).toMatch(/^env_[a-f0-9]{32}$/);
    expect(second.id).toBe(first.id);
    expect(await manager.identity({ ...request, ownerId: "owner-2" })).not.toMatchObject({ id: first.id });
  });

  test("coalesces concurrent ensure calls and makes subsequent ensure/start idempotent", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);

    const [first, concurrent] = await Promise.all([manager.ensure(request), manager.ensure(request)]);
    const started = await manager.start(request);
    const ensuredAgain = await manager.ensure(request);

    expect(first).toEqual(concurrent);
    expect(started).toEqual(first);
    expect(ensuredAgain).toEqual(first);
    expect(backend.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(backend.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  test("rejects backend records owned by another principal", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);
    const identity = await manager.identity(request);
    const record = await backend.create(identity);
    backend.mismatch = true;

    await expect(manager.start(request)).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    expect(record.ownerId).toBe(request.ownerId);
    expect(backend.calls).not.toContain("start");
  });

  test("propagates backend unavailability without a local execution fallback", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    backend.failStart = true;
    const manager = createEnvironmentManager(backend);

    await expect(manager.ensure(request)).rejects.toBeInstanceOf(EnvironmentManagerError);
    await expect(manager.ensure(request)).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    expect(backend.calls).toContain("create");
    expect(backend.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  test("rejects lexical and symlink escapes from the configured storage root", async () => {
    const { request, root } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const escapeLink = path.join(request.storageRoot, "escape");
    await symlink(outside, escapeLink);
    const manager = createEnvironmentManager(new FakeBackend());

    await expect(manager.identity({ ...request, worktreePath: outside })).rejects.toMatchObject({ code: "WORKTREE_OUTSIDE_ROOT" });
    await expect(manager.identity({ ...request, worktreePath: path.join(escapeLink, "missing") })).rejects.toBeInstanceOf(EnvironmentManagerError);
    await expect(manager.identity({ ...request, worktreePath: path.join(escapeLink, "..", "..", "outside") })).rejects.toMatchObject({ code: "WORKTREE_OUTSIDE_ROOT" });
  });
});
