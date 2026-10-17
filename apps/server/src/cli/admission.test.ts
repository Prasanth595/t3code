// @effect-diagnostics nodeBuiltinImport:off -- CLI integration owns its local socket and private credential-consumer fixture.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { afterEach, expect, it } from "vite-plus/test";
import { admissionCommand } from "./admission.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function fixture(
  originOverride?: string,
  scopes = ["orchestration:read", "orchestration:operate"],
) {
  const received: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const server = NodeHttp.createServer((request, response) => {
    received.push({
      method: request.method!,
      url: request.url!,
      authorization: request.headers.authorization,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ draining: request.url?.endsWith("drain") ?? false, running: 0, queued: 2 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No socket");
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "admission-cli-"));
  cleanup.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const runtime = NodePath.join(directory, "runtime.json");
  const config = NodePath.join(directory, "config.json");
  const consumer = NodePath.join(directory, "credential.cjs");
  await NodeFSP.writeFile(
    runtime,
    JSON.stringify({ origin: originOverride ?? `http://127.0.0.1:${address.port}` }),
  );
  await NodeFSP.writeFile(
    consumer,
    `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify(${JSON.stringify(
      {
        ok: true,
        value: {
          token: "fixture-private-token",
          expires_at: "2100-01-01T00:00:00Z",
          scopes,
        },
      },
    )})));`,
  );
  await NodeFSP.writeFile(
    config,
    JSON.stringify({ runtime, credential_command: [process.execPath, consumer] }),
  );
  return { config, received };
}

const run = (config: string, operation: string) =>
  Command.runWith(admissionCommand, { version: "test" })([operation, "--config", config]).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

it("calls all admission operations using the existing private operator credential consumer", async () => {
  const { config, received } = await fixture();
  await run(config, "drain");
  await run(config, "status");
  await run(config, "resume");
  expect(received.map(({ method, url }) => [method, url])).toEqual([
    ["POST", "/api/local/admission/drain"],
    ["GET", "/api/local/admission/status"],
    ["POST", "/api/local/admission/resume"],
  ]);
  expect(
    received.every((request) => request.authorization === "Bearer fixture-private-token"),
  ).toBe(true);
});

it("refuses non-loopback runtime metadata before sending a credential", async () => {
  const { config, received } = await fixture("https://example.com");
  await expect(run(config, "drain")).rejects.toThrow("Admission request failed");
  expect(received).toEqual([]);
});

it("refuses an operator credential missing operate scope", async () => {
  const { config, received } = await fixture(undefined, ["orchestration:read"]);
  await expect(run(config, "drain")).rejects.toThrow("Admission request failed");
  expect(received).toEqual([]);
});
