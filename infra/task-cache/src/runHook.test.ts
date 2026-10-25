// @effect-diagnostics nodeBuiltinImport:off - exercises the real native runner and local HTTP collector.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("uses one machine hook across fresh worktrees without modifying Vite+", async () => {
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
    const runner = NodePath.join(root, "vite-plus");
    const distribution = NodePath.resolve(
      import.meta.dirname,
      "../../../node_modules/vite-plus/dist",
    );
    await NodeFSP.cp(distribution, NodePath.join(runner, "dist"), { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(distribution, "../package.json"),
      NodePath.join(runner, "package.json"),
    );
    await NodeFSP.symlink(
      NodePath.resolve(distribution, "../binding"),
      NodePath.join(runner, "binding"),
    );
    await NodeFSP.symlink(
      NodePath.resolve(distribution, "../.."),
      NodePath.join(runner, "node_modules"),
    );
    const entrypoint = NodePath.join(runner, "dist/bin.js");
    const endpoint = `http://127.0.0.1:${address.port}/projects/test`;
    await NodeFSP.writeFile(NodePath.join(root, ".task-cache.json"), JSON.stringify({ endpoint }));
    await NodeFSP.writeFile(
      NodePath.join(root, "package.json"),
      JSON.stringify({
        name: "hook-fixture",
        private: true,
        scripts: { build: 'node -e "console.log(42)"', fail: 'node -e "process.exit(7)"' },
      }),
    );
    const configDirectory = NodePath.join(root, ".config/vite-plus");
    await NodeFSP.mkdir(configDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(configDirectory, "run-hook.json"),
      JSON.stringify({
        rootMarker: ".task-cache.json",
        module: NodePath.join(import.meta.dirname, "runHook.ts"),
      }),
    );
    const originalEntrypoint = await NodeFSP.readFile(entrypoint, "utf8");
    const run = (task: string, cwd = root) =>
      new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [entrypoint, "run", "--cache", task],
          {
            cwd,
            env: {
              ...process.env,
              HOME: root,
              NODE_OPTIONS: `--import=${new URL("./preload.mjs", import.meta.url).href}`,
              VP_REMOTE_CACHE: "off",
              VP_REMOTE_CACHE_URL: endpoint.replace("http://", "http://maria:secret@"),
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code !== 0 && task !== "fail" ? reject(new Error(stderr)) : resolve(code),
        );
      });
    expect(await run("build")).toBe(0);
    expect(await run("build")).toBe(0);
    expect(await run("fail")).toBe(7);
    const secondWorktree = NodePath.join(root, "second-worktree");
    await NodeFSP.mkdir(secondWorktree);
    for (const file of ["package.json", ".task-cache.json"])
      await NodeFSP.copyFile(NodePath.join(root, file), NodePath.join(secondWorktree, file));
    expect(await run("build", secondWorktree)).toBe(0);
    expect(await NodeFSP.readFile(entrypoint, "utf8")).toBe(originalEntrypoint);
    expect(reports).toHaveLength(4);
    expect(
      reports.every(
        (report) =>
          report.authorization === `Basic ${Buffer.from("maria:secret").toString("base64")}`,
      ),
    ).toBe(true);
    const events = reports.map((report) => JSON.parse(report.body));
    expect(events[0].tasks[0].source).toBe("executed");
    expect(events[1].tasks[0].source).toBe("local");
    expect(events[3].tasks[0].source).toBe("executed");
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
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

it("does not start telemetry or create local state without cache credentials", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-unconfigured-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(root, ".task-cache.json"),
      JSON.stringify({ endpoint: "https://cache.invalid/projects/test" }),
    );
    const hook = new URL("./runHook.ts", import.meta.url).href;
    const output = await new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import start from ${JSON.stringify(hook)}; const finish = start({ root: process.cwd() }); if (finish !== undefined) process.exit(1);`,
        ],
        {
          cwd: root,
          env: { ...process.env, HOME: root, VP_REMOTE_CACHE_URL: "" },
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
      child.once("close", (code) =>
        code === 0 ? resolve(output) : reject(new Error(output || `Exited ${code}`)),
      );
    });
    expect(output).toBe("");
    expect(await NodeFSP.readdir(root)).toEqual([".task-cache.json"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
