import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEnvironmentManager,
} from "../src/index.ts";
import {
  createDockerEnvironmentBackend,
  DockerEnvironmentError,
  type DockerClient,
  type DockerContainerCreateOptions,
  type DockerContainerInspection,
  type DockerContainerProcessRequest,
  type DockerContainerManagedSessionRequest,
} from "../src/docker.ts";
import type { EnvironmentManagedProcessSession } from "../src/index.ts";

const tempRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-docker-backend-"));
  tempRoots.push(root);
  const gatewayStorageRoot = path.join(root, "gateway-workspaces");
  const hostStorageRoot = path.join(root, "docker-host-workspaces");
  const gatewayWorktree = path.join(gatewayStorageRoot, "repo", "worktree-a");
  const hostWorktree = path.join(hostStorageRoot, "repo", "worktree-a");
  await Promise.all([
    mkdir(path.join(gatewayWorktree, ".git"), { recursive: true }),
    mkdir(path.join(hostWorktree, ".git"), { recursive: true }),
  ]);
  const request = {
    ownerId: "owner-1",
    workspaceId: "workspace-1",
    storageRoot: gatewayStorageRoot,
    worktreePath: gatewayWorktree,
  };
  const config = {
    gatewayStorageRoot,
    hostStorageRoot,
    containerStorageRoot: "/workspaces",
    image: "registry.example/subpolar-worker@sha256:0123456789abcdef",
  };
  const client = new FakeDockerClient();
  const backend = createDockerEnvironmentBackend(client, config);
  const manager = createEnvironmentManager(backend);
  const identity = await manager.identity(request);
  return { root, request, config, client, backend, manager, identity, hostWorktree };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeDockerClient implements DockerClient {
  readonly containers = new Map<string, DockerContainerInspection>();
  readonly createCalls: DockerContainerCreateOptions[] = [];
  readonly startCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly removeCalls: string[] = [];
  readonly processCalls: Array<{ id: string; request: DockerContainerProcessRequest }> = [];
  readonly managedSessionCalls: Array<{ id: string; request: DockerContainerManagedSessionRequest }> = [];
  wrongOwner = false;

  async inspectContainer(name: string) {
    const current = this.containers.get(name);
    if (!current) return null;
    if (!this.wrongOwner) return current;
    return { ...current, labels: { ...current.labels, "io.subpolar.owner-sha256": "not-the-owner" } };
  }

  async createContainer(options: DockerContainerCreateOptions) {
    this.createCalls.push(options);
    const id = `docker-${options.name}`;
    const inspection: DockerContainerInspection = {
      id,
      name: options.name,
      state: "created",
      labels: options.labels,
      config: {
        image: options.image,
        user: options.user,
        privileged: options.privileged,
        readOnlyRootfs: options.readOnlyRootfs,
        networkMode: options.networkMode,
        capDrop: options.capDrop,
        securityOpt: options.securityOpt,
        memoryBytes: options.memoryBytes,
        nanoCpus: options.nanoCpus,
        pidsLimit: options.pidsLimit,
        mounts: options.mounts,
        tmpfs: options.tmpfs,
        environment: options.environment,
      },
    };
    this.containers.set(options.name, inspection);
    return { id };
  }

  async startContainer(id: string) {
    this.startCalls.push(id);
    this.update(id, { state: "running" });
  }

  async stopContainer(id: string, options: { readonly timeoutSeconds: 10 }) {
    expect(options.timeoutSeconds).toBe(10);
    this.stopCalls.push(id);
    this.update(id, { state: "exited" });
  }

  async removeContainer(id: string, options: { readonly force: false; readonly removeVolumes: false }) {
    expect(options).toEqual({ force: false, removeVolumes: false });
    this.removeCalls.push(id);
    for (const [name, container] of this.containers) if (container.id === id) this.containers.delete(name);
  }

  async executeContainer(id: string, request: DockerContainerProcessRequest) {
    this.processCalls.push({ id, request });
    await request.onOutput?.({ stream: "stdout", data: new TextEncoder().encode("hello") });
    return { processId: "exec-1", exitCode: 7, cancelled: request.signal?.aborted ?? false };
  }

  async startManagedSessionContainer(id: string, request: DockerContainerManagedSessionRequest): Promise<EnvironmentManagedProcessSession> {
    this.managedSessionCalls.push({ id, request });
    return {
      async write() {},
      output: { async *[Symbol.asyncIterator]() {} },
      result: Promise.resolve({ exitCode: null, cancelled: false }),
      async terminate() {},
    };
  }

  private update(id: string, patch: Partial<DockerContainerInspection>) {
    for (const [name, container] of this.containers) {
      if (container.id === id) this.containers.set(name, { ...container, ...patch });
    }
  }
}

describe("Docker environment backend", () => {
  test("executes argv in the verified mounted worktree and streams output", async () => {
    const { backend, identity, client } = await fixture();
    const created = await backend.create(identity);
    const ready = await backend.start(created);
    const output: string[] = [];
    const result = await backend.execute(ready, ["node", "-e", "process.exit(7)"], {
      cwd: "packages",
      environment: { NODE_ENV: "test" },
      onOutput: ({ stream, data }) => output.push(`${stream}:${new TextDecoder().decode(data)}`),
    });

    expect(result).toEqual({ processId: "exec-1", exitCode: 7, cancelled: false });
    expect(client.processCalls[0]).toMatchObject({
      id: ready.resourceId,
      request: {
        command: ["node", "-e", "process.exit(7)"],
        workingDirectory: "/workspaces/repo/worktree-a/packages",
        environment: { NODE_ENV: "test" },
      },
    });
    expect(output).toEqual(["stdout:hello"]);
  });

  test("keeps worker egress closed when a process supplies proxy environment variables", async () => {
    const { backend, identity, client } = await fixture();
    const ready = await backend.start(await backend.create(identity));

    await backend.execute(ready, ["node", "agent.js"], {
      cwd: ".",
      environment: {
        HTTPS_PROXY: "http://proxy.example:8080",
        ALL_PROXY: "socks5://proxy.example:1080",
      },
    });

    expect(client.createCalls[0]?.networkMode).toBe("none");
    expect(client.processCalls[0]?.request.environment).toEqual({
      HTTPS_PROXY: "http://proxy.example:8080",
      ALL_PROXY: "socks5://proxy.example:1080",
    });
  });

  test("starts non-TTY process sessions inside the verified mounted worktree", async () => {
    const { backend, identity, client } = await fixture();
    const ready = await backend.start(await backend.create(identity));
    const session = await backend.startManagedSession(ready, ["node", "acp-server.js"], {
      cwd: "packages", environment: { MODE: "stdio" }, clientSessionId: "thread-acp",
    });
    expect(client.managedSessionCalls[0]).toMatchObject({
      id: ready.resourceId,
      request: {
        command: ["node", "acp-server.js"],
        worktreeDirectory: "/workspaces/repo/worktree-a",
        workingDirectory: "/workspaces/repo/worktree-a/packages",
        environment: { MODE: "stdio" },
      },
    });
    await expect(backend.startManagedSession({ ...ready, ownerId: "other-owner" }, ["node"], {})).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    await session.terminate();
  });

  test("rejects process working directories that escape the worktree", async () => {
    const { backend, identity, client } = await fixture();
    const ready = await backend.start(await backend.create(identity));

    await expect(backend.execute(ready, ["id"], { cwd: "../../etc" })).rejects.toMatchObject({ code: "PROCESS_REQUEST_INVALID" });
    expect(client.processCalls).toEqual([]);
  });

  test("maps the explicit gateway path to the daemon host and enforces safe defaults", async () => {
    const { client, manager, request, identity, config } = await fixture();
    const created = await manager.ensure(request);
    const options = client.createCalls[0]!;

    expect(created.status).toBe("ready");
    expect(options.mounts).toEqual([{
      type: "bind",
      source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")),
      target: "/workspaces/repo/worktree-a",
      readOnly: false,
    }]);
    expect(options).toMatchObject({
      user: "1000:1000",
      privileged: false,
      readOnlyRootfs: true,
      networkMode: "none",
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      memoryBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
    });
    expect(JSON.stringify(options)).not.toContain("docker.sock");
    expect(options.mounts).toHaveLength(1);
  });

  test("discovers a JSONC image configuration while keeping manager isolation defaults", async () => {
    const { client, manager, request, identity, config } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), `{
      // A project image is supported without granting it host access.
      "$schema": "https://containers.dev/schema/devContainer.schema.json",
      "name": "worker",
      "image": "registry.example/project@sha256:abcdef",
    }`);

    await manager.ensure(request);

    expect(client.createCalls[0]).toMatchObject({
      image: "registry.example/project@sha256:abcdef",
      privileged: false,
      networkMode: "none",
      mounts: [{ source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")) }],
    });
  });

  test("requires an explicit choice when several Dev Container configurations exist", async () => {
    const { client, manager, request, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "api"), { recursive: true });
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "web"), { recursive: true });
    await Promise.all([
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "api", "devcontainer.json"), '{"image":"api:latest"}'),
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "web", "devcontainer.json"), '{"image":"web:latest"}'),
    ]);

    await expect(manager.ensure(request)).rejects.toMatchObject({
      cause: { code: "DEV_CONTAINER_CONFIGURATION_SELECTION_REQUIRED" },
    });
    expect(client.createCalls).toEqual([]);
  });

  test("fails closed on Dev Container options that need additional lifecycle support", async () => {
    const { client, manager, request, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      features: { "ghcr.io/devcontainers/features/node:1": {} },
    }));

    await expect(manager.ensure(request)).rejects.toMatchObject({
      cause: { code: "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED" },
    });
    expect(client.createCalls).toEqual([]);
  });

  test("uses the configured default selection for multiple Dev Container configurations", async () => {
    const { client, request, identity, config } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "api"), { recursive: true });
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "web"), { recursive: true });
    await Promise.all([
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "api", "devcontainer.json"), '{"image":"api:latest"}'),
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "web", "devcontainer.json"), '{"image":"web:latest"}'),
    ]);
    const selected = createDockerEnvironmentBackend(client, {
      ...config,
      defaultDevContainerConfiguration: ".devcontainer/api/devcontainer.json",
    });

    await createEnvironmentManager(selected).ensure(request);
    expect(client.createCalls[0]?.image).toBe("api:latest");
  });

  test("verifies owner labels before every lifecycle operation", async () => {
    const { backend, client, identity } = await fixture();
    const created = await backend.create(identity);
    client.wrongOwner = true;

    await expect(backend.start(created)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.startCalls).toEqual([]);
    await expect(backend.stop(created)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.stopCalls).toEqual([]);
    await expect(backend.remove(created)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.removeCalls).toEqual([]);
  });

  test("rejects a linked Git worktree when shared metadata roots are not configured", async () => {
    const { backend, client, identity, request } = await fixture();
    await rm(path.join(identity.worktreePath, ".git"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".git"), "gitdir: ../../.git/worktrees/worktree-a\n");
    await Bun.write(path.join(request.storageRoot, "repo", "worktree-a", ".git"), "gitdir: ../../.git/worktrees/worktree-a\n");

    await expect(backend.create(identity)).rejects.toBeInstanceOf(DockerEnvironmentError);
    await expect(backend.create(identity)).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_LAYOUT" });
    expect(client.createCalls).toEqual([]);
  });

  test("mounts only the verified shared Git directory for a linked T3 worktree", async () => {
    const { backend, client, identity, config, root } = await fixture();
    const gatewayGitRoot = path.join(root, "gateway-git-metadata");
    const hostGitRoot = path.join(root, "docker-host-git-metadata");
    const gatewayCommonDir = path.join(gatewayGitRoot, "project", ".git");
    const hostCommonDir = path.join(hostGitRoot, "project", ".git");
    const gatewayGitDir = path.join(gatewayCommonDir, "worktrees", "t3-worktree");
    const hostGitDir = path.join(hostCommonDir, "worktrees", "t3-worktree");
    await Promise.all([
      mkdir(gatewayGitDir, { recursive: true }),
      mkdir(hostGitDir, { recursive: true }),
    ]);
    await Promise.all([
      rm(path.join(identity.worktreePath, ".git"), { recursive: true }),
      rm(path.join(config.hostStorageRoot, "repo", "worktree-a", ".git"), { recursive: true }),
    ]);
    await Promise.all([
      Bun.write(path.join(gatewayGitDir, "commondir"), "../..\n"),
      Bun.write(path.join(hostGitDir, "commondir"), "../..\n"),
      Bun.write(path.join(identity.worktreePath, ".git"), `gitdir: ${gatewayGitDir}\n`),
      Bun.write(path.join(config.hostStorageRoot, "repo", "worktree-a", ".git"), `gitdir: ${hostGitDir}\n`),
    ]);

    const linkedBackend = createDockerEnvironmentBackend(client, {
      ...config,
      gatewayGitRoot,
      hostGitRoot,
    });
    await linkedBackend.create(identity);
    expect(client.createCalls[0]?.mounts).toEqual([
      {
        type: "bind",
        source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")),
        target: "/workspaces/repo/worktree-a",
        readOnly: false,
      },
      {
        type: "bind",
        source: await realpath(hostCommonDir),
        target: await realpath(gatewayCommonDir),
        readOnly: false,
      },
    ]);
  });

  test("revalidates daemon-host paths and rejects symlink escapes", async () => {
    const { backend, client, identity, hostWorktree, root } = await fixture();
    await rm(hostWorktree, { recursive: true });
    const outside = path.join(root, "outside-worktree");
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(outside, ".git"));
    await symlink(outside, hostWorktree);

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_INVALID" });
    await expect(backend.create(identity)).rejects.toBeInstanceOf(DockerEnvironmentError);
    expect(client.createCalls).toEqual([]);
  });

  test("does not adopt an unlabelled container with the stable name", async () => {
    const { backend, client, identity } = await fixture();
    const valid = await backend.create(identity);
    const [containerName] = client.containers.keys();
    const current = client.containers.get(containerName!)!;
    client.containers.set(containerName!, { ...current, labels: { ...current.labels, "io.subpolar.environment-id": "other" } });

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    await expect(backend.start(valid)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.startCalls).toEqual([]);
  });

  test("rejects inspected containers with extra mounts or changed isolation settings", async () => {
    const { backend, client, identity } = await fixture();
    await backend.create(identity);
    const [name] = client.containers.keys();
    const container = client.containers.get(name!)!;
    client.containers.set(name!, {
      ...container,
      config: {
        ...container.config,
        mounts: [...container.config.mounts, {
          type: "bind",
          source: "/var/run/docker.sock",
          target: "/var/run/docker.sock",
          readOnly: false,
        }],
      },
    });

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "DOCKER_CONFIGURATION_MISMATCH" });
  });

  test("refuses to execute in a worker whose network is no longer isolated", async () => {
    const { backend, client, identity } = await fixture();
    const ready = await backend.start(await backend.create(identity));
    const [name] = client.containers.keys();
    const container = client.containers.get(name!)!;
    client.containers.set(name!, {
      ...container,
      config: { ...container.config, networkMode: "bridge" },
    });

    await expect(backend.execute(ready, ["node", "agent.js"], {})).rejects.toMatchObject({
      code: "DOCKER_CONFIGURATION_MISMATCH",
    });
    expect(client.processCalls).toEqual([]);
  });
});
