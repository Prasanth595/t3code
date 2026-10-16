import { expect, test } from "bun:test";
import { createEnvironmentManagerHttpClient } from "../src/manager-client.ts";
import type { EnvironmentIdentity, ManagedEnvironment } from "../src/index.ts";

const TOKEN = "manager-client-token-with-more-than-thirty-two-characters";
const identity: EnvironmentIdentity = {
  id: "environment-a",
  ownerId: "user-a",
  workspaceId: "workspace-a",
  storageRoot: "/workspaces",
  worktreePath: "/workspaces/repo",
};
const environment: ManagedEnvironment = {
  ...identity,
  backendId: "test",
  resourceId: "resource-a",
  status: "ready",
};

test("manager client authenticates lifecycle calls and reads responses", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (String(input).endsWith("/identity")) return Response.json(identity);
    return Response.json(environment);
  }) as typeof fetch;
  const manager = createEnvironmentManagerHttpClient({ baseUrl: "http://manager:8080/", token: TOKEN, fetch: fetcher });

  await expect(manager.identity({ ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath })).resolves.toEqual(identity);
  await expect(manager.ensure({ ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath })).resolves.toEqual(environment);
  expect(calls.map((call) => [call.url, call.authorization])).toEqual([
    ["http://manager:8080/v1/environments/identity", `Bearer ${TOKEN}`],
    ["http://manager:8080/v1/environments/ensure", `Bearer ${TOKEN}`],
  ]);
});

test("manager client decodes streamed process output and results", async () => {
  const body = [
    JSON.stringify({ type: "output", stream: "stderr", data: "bm90aWNl" }),
    JSON.stringify({ type: "result", result: { processId: "process-a", exitCode: 3, cancelled: false } }),
  ].join("\n") + "\n";
  const manager = createEnvironmentManagerHttpClient({
    baseUrl: "http://manager:8080",
    token: TOKEN,
    fetch: (async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch,
  });
  const output: string[] = [];

  await expect(manager.execute({ ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath }, ["tool", "arg"], {
    onOutput: ({ stream, data }) => output.push(`${stream}:${new TextDecoder().decode(data)}`),
  })).resolves.toEqual({ processId: "process-a", exitCode: 3, cancelled: false });
  expect(output).toEqual(["stderr:notice"]);
});

test("manager client rejects URLs with embedded credentials", () => {
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "http://user:password@manager", token: TOKEN })).toThrow(/cannot contain credentials/);
});
