import { expect, test } from "bun:test";
import { createEnvironmentManagerHttpHandler } from "../src/manager-http.ts";
import type { EnvironmentManager, EnvironmentRequest, ManagedEnvironment } from "../src/index.ts";

const TOKEN = "manager-test-token-with-more-than-thirty-two-characters";
const requestInput: EnvironmentRequest = {
  ownerId: "user-a",
  workspaceId: "workspace-a",
  storageRoot: "/workspaces",
  worktreePath: "/workspaces/repo",
};
const environment: ManagedEnvironment = {
  ...requestInput,
  id: "environment-a",
  backendId: "test",
  resourceId: "resource-a",
  status: "ready",
};

function managerFixture() {
  const calls: Array<{ method: string; request?: EnvironmentRequest; command?: readonly string[] }> = [];
  const manager = {
    identity: async () => ({ ...environment }),
    ensure: async (request: EnvironmentRequest) => { calls.push({ method: "ensure", request }); return environment; },
    start: async (request: EnvironmentRequest) => { calls.push({ method: "start", request }); return environment; },
    stop: async (request: EnvironmentRequest) => { calls.push({ method: "stop", request }); return { ...environment, status: "stopped" as const }; },
    remove: async (request: EnvironmentRequest) => { calls.push({ method: "remove", request }); },
    execute: async (request: EnvironmentRequest, command: readonly string[], process: { onOutput?: (output: { stream: "stdout" | "stderr"; data: Uint8Array }) => void | Promise<void> }) => {
      calls.push({ method: "execute", request, command });
      await process.onOutput?.({ stream: "stdout", data: new TextEncoder().encode("ok") });
      return { processId: "process-a", exitCode: 0, cancelled: false };
    },
    reconcile: async () => [],
  } satisfies EnvironmentManager;
  return { manager, calls };
}

function makeRequest(path: string, body?: unknown, token: string | null = TOKEN) {
  return new Request(`http://manager${path}`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("manager API rejects missing or invalid bearer credentials before dispatch", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const missing = await handle(makeRequest("/v1/environments/ensure", { environment: requestInput }, null));
  const invalid = await handle(makeRequest("/v1/environments/ensure", { environment: requestInput }, "wrong"));
  const multibyte = await handle(makeRequest("/v1/environments/ensure", { environment: requestInput }, TOKEN.replace("a", "é")));
  expect(missing.status).toBe(401);
  expect(invalid.status).toBe(401);
  expect(multibyte.status).toBe(401);
  expect(calls).toEqual([]);
});

test("manager API validates the route body and dispatches lifecycle operations", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const response = await handle(makeRequest("/v1/environments/stop", { environment: requestInput }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "stopped" });
  expect(calls).toEqual([{ method: "stop", request: requestInput }]);

  const invalid = await handle(makeRequest("/v1/environments/ensure", { environment: { ...requestInput, ownerId: 3 } }));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "INVALID_REQUEST" });
});

test("manager API streams process output and the final result as NDJSON", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const response = await handle(makeRequest("/v1/environments/execute", {
    environment: requestInput,
    command: ["node", "-e", "process.stdout.write('ok')"],
    process: { cwd: "packages", environment: { MODE: "test" } },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("application/x-ndjson");
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toEqual([
    { type: "output", stream: "stdout", data: "b2s=" },
    { type: "result", result: { processId: "process-a", exitCode: 0, cancelled: false } },
  ]);
  expect(calls).toEqual([{ method: "execute", request: requestInput, command: ["node", "-e", "process.stdout.write('ok')"] }]);
});

test("manager API cancels managed execution when its output stream is abandoned", async () => {
  let aborted = false;
  const manager: EnvironmentManager = {
    ...managerFixture().manager,
    execute: async (_request, _command, process) => {
      await process.onOutput?.({ stream: "stdout", data: new TextEncoder().encode("started") });
      await new Promise<void>((resolve) => {
        if (process.signal?.aborted) resolve();
        else process.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = process.signal?.aborted === true;
      return { exitCode: null, cancelled: true };
    },
  };
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);
  const response = await handle(makeRequest("/v1/environments/execute", {
    environment: requestInput,
    command: ["long-running"],
  }));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(aborted).toBe(true);
});
