import { expect, test } from "bun:test";
import { createDockerEngineClient } from "../src/docker-engine.ts";
import type { DockerContainerCreateOptions, DockerContainerProcessRequest } from "../src/docker.ts";

function engineFixture(
  handler: (request: { method: string; url: string; body: string }) => { status: number; body?: unknown },
  processRunner?: (containerId: string, request: DockerContainerProcessRequest) => Promise<{ processId?: string; exitCode: number | null; cancelled: boolean }>,
) {
  return createDockerEngineClient({
    socketPath: "/var/run/docker.sock",
    ...(processRunner === undefined ? {} : { processRunner }),
    transport: async (request) => {
      const result = handler({
        method: request.method,
        url: request.path,
        body: request.body ? Buffer.from(request.body).toString("utf8") : "",
      });
      return {
        statusCode: result.status,
        body: result.body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(result.body)),
      };
    },
  });
}

const createOptions: DockerContainerCreateOptions = {
  name: "subpolar-env_123",
  image: "worker@sha256:abc",
  labels: { "io.subpolar.environment-id": "env_123" },
  user: "1000:1000",
  privileged: false,
  readOnlyRootfs: true,
  networkMode: "none",
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges:true"],
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pidsLimit: 100,
  mounts: [{ type: "bind", source: "/host/worktree", target: "/workspaces/repo", readOnly: false }],
  tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
  environment: { HOME: "/tmp/home" },
};

test("maps safe lifecycle operations to the Docker Engine API", async () => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const client = engineFixture((request) => {
    requests.push(request);
    if (request.method === "GET") return { status: 200, body: {
      Id: "container-1",
      Name: "/subpolar-env_123",
      State: { Status: "running" },
      Config: { Image: "worker@sha256:abc", User: "1000:1000", Labels: { "io.subpolar.environment-id": "env_123" }, Env: ["HOME=/tmp/home"] },
      HostConfig: {
        Privileged: false, ReadonlyRootfs: true, NetworkMode: "none", CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"], Memory: 512 * 1024 * 1024, NanoCpus: 500_000_000,
        PidsLimit: 100, Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
      },
      Mounts: [{ Type: "bind", Source: "/host/worktree", Destination: "/workspaces/repo", RW: true }],
    } };
    if (request.url?.includes("/containers/create")) return { status: 201, body: { Id: "container-1" } };
    return { status: 204 };
  });

  const inspection = await client.inspectContainer("subpolar-env_123");
  expect(inspection).toMatchObject({
    id: "container-1",
    name: "subpolar-env_123",
    state: "running",
    config: { image: createOptions.image, networkMode: "none", mounts: [{ source: "/host/worktree", target: "/workspaces/repo", readOnly: false }] },
  });
  await expect(client.createContainer(createOptions)).resolves.toEqual({ id: "container-1" });
  await client.startContainer("container-1");
  await client.stopContainer("container-1", { timeoutSeconds: 10 });
  await client.removeContainer("container-1", { force: false, removeVolumes: false });

  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "/v1.41/containers/subpolar-env_123/json"],
    ["POST", "/v1.41/containers/create?name=subpolar-env_123"],
    ["POST", "/v1.41/containers/container-1/start"],
    ["POST", "/v1.41/containers/container-1/stop?t=10"],
    ["DELETE", "/v1.41/containers/container-1?force=false&v=false"],
  ]);
  const payload = JSON.parse(requests[1]!.body) as { HostConfig: Record<string, unknown> };
  expect(payload.HostConfig).toMatchObject({
    Privileged: false,
    ReadonlyRootfs: true,
    NetworkMode: "none",
    CapDrop: ["ALL"],
    PidsLimit: 100,
    Mounts: [{ Type: "bind", Source: "/host/worktree", Target: "/workspaces/repo", ReadOnly: false }],
  });
});

test("returns null for an unknown container and does not leak daemon error details", async () => {
  const client = engineFixture(() => ({ status: 404, body: { message: "sensitive host detail" } }));
  await expect(client.inspectContainer("missing")).resolves.toBeNull();
  await expect(client.startContainer("missing")).rejects.toMatchObject({
    name: "DockerEngineClientError",
    message: "Docker Engine request failed with HTTP 404",
  });
});

test("routes container process requests through the worker runner", async () => {
  let seen: { id: string; request: DockerContainerProcessRequest } | undefined;
  const client = engineFixture(
    () => ({ status: 404 }),
    async (id, request) => {
      seen = { id, request };
      await request.onOutput?.({ stream: "stderr", data: new TextEncoder().encode("warning") });
      return { processId: "worker-process-1", exitCode: 0, cancelled: false };
    },
  );
  const output: string[] = [];
  const request = {
    command: ["node", "-e", "console.log('hello')"],
    worktreeDirectory: "/workspaces/repo",
    workingDirectory: "/workspaces/repo/packages",
    environment: { MODE: "test" },
    onOutput: ({ stream, data }: { stream: string; data: Uint8Array }) => output.push(`${stream}:${new TextDecoder().decode(data)}`),
  };

  await expect(client.executeContainer!("container-9", request)).resolves.toEqual({
    processId: "worker-process-1",
    exitCode: 0,
    cancelled: false,
  });
  expect(seen).toEqual({ id: "container-9", request });
  expect(output).toEqual(["stderr:warning"]);
});
