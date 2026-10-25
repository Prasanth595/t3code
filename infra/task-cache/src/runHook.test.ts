// @effect-diagnostics nodeBuiltinImport:off - exercises the real native runner and local HTTP collector.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("exports native run summaries with environment credentials and preserves failure status", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-hook-"));
  const reports: { authorization: string | undefined; body: string }[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    reports.push({ authorization: request.headers.authorization, body });
    response.writeHead(204).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const endpoint = `http://127.0.0.1:${address.port}/projects/test`;
    await NodeFSP.writeFile(NodePath.join(root, ".task-cache.json"), JSON.stringify({ endpoint }));
    await NodeFSP.writeFile(
      NodePath.join(root, "package.json"),
      JSON.stringify({
        name: "hook-fixture",
        private: true,
        vitePlus: { runHook: NodePath.join(import.meta.dirname, "runHook.ts") },
        scripts: { build: 'node -e "console.log(42)"', fail: 'node -e "process.exit(7)"' },
      }),
    );
    const run = (task: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          NodePath.resolve(import.meta.dirname, "../../../node_modules/.bin/vp"),
          ["run", "--cache", task],
          {
            cwd: root,
            env: {
              ...process.env,
              HOME: root,
              VP_REMOTE_CACHE: "off",
              VP_REMOTE_CACHE_URL: endpoint.replace("http://", "http://maria:secret@"),
            },
            stdio: "ignore",
          },
        );
        child.once("error", reject);
        child.once("close", resolve);
      });
    expect(await run("build")).toBe(0);
    expect(await run("build")).toBe(0);
    expect(await run("fail")).toBe(7);
    expect(reports).toHaveLength(3);
    expect(
      reports.every(
        (report) =>
          report.authorization === `Basic ${Buffer.from("maria:secret").toString("base64")}`,
      ),
    ).toBe(true);
    const events = reports.map((report) => JSON.parse(report.body));
    expect(events[0].tasks[0].source).toBe("executed");
    expect(events[1].tasks[0].source).toBe("local");
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects invalid setup credentials before installing anything and never prints the token", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-setup-"));
  const token = "private-credential-that-must-not-appear-in-output";
  const server = NodeHttp.createServer((_request, response) => response.writeHead(401).end());
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../scripts/install.ts"), "--non-interactive"],
        {
          env: {
            ...process.env,
            HOME: home,
            T3_CACHE_SETUP_URL: `http://127.0.0.1:${address.port}/projects/test`,
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: token,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Credential verification failed (401)");
    expect(result.output).not.toContain(token);
    expect(await NodeFSP.readdir(home)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
