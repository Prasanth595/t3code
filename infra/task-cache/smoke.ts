// @effect-diagnostics nodeBuiltinImport:off - exercises real child processes and isolated workspaces.
// @effect-diagnostics globalConsole:off - emits the deployment acceptance transcript.
// @effect-diagnostics globalFetch:off - probes the deployed Worker directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { cacheEnvironment } from "./vp.ts";

const project = NodePath.join(import.meta.dirname, "../..");
const env = cacheEnvironment(project, process.env);
if (env.VP_REMOTE_CACHE !== "read-write") throw new Error("Import a writer credential first.");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cache-probe-"));
const name = `t3-cache-probe-${NodeCrypto.randomUUID()}`;

async function run(directory: string) {
  return new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      NodePath.join(project, "node_modules/.bin/vp"),
      ["run", "--cache", "build"],
      {
        cwd: NodePath.join(root, directory),
        env,
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
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

try {
  const { endpoint } = JSON.parse(
    await NodeFSP.readFile(NodePath.join(project, ".task-cache.json"), "utf8"),
  );
  const unauthorized = await fetch(`${endpoint}/store`, { method: "POST" });
  await unauthorized.body?.cancel();
  if (unauthorized.status !== 401)
    throw new Error(`Anonymous upload returned ${unauthorized.status}, expected 401.`);
  for (const directory of ["a", "b"]) {
    const cwd = NodePath.join(root, directory);
    await NodeFSP.mkdir(cwd);
    await NodeFSP.writeFile(
      NodePath.join(cwd, "package.json"),
      JSON.stringify({ name, private: true, scripts: { build: `node build.cjs ${name}` } }),
    );
    await NodeFSP.writeFile(
      NodePath.join(cwd, "build.cjs"),
      'const fs=require("node:fs"); fs.writeFileSync("output.txt",fs.readFileSync("input.txt")); console.log("computed");',
    );
    await NodeFSP.writeFile(NodePath.join(cwd, "input.txt"), "version-a");
  }
  console.log("First checkout:\n" + (await run("a")));
  const second = await run("b");
  console.log("Cold second checkout:\n" + second);
  if (!second.includes("remote cache hit"))
    throw new Error("Second checkout did not reuse the remote result.");
  if ((await NodeFSP.readFile(NodePath.join(root, "b/output.txt"), "utf8")) !== "version-a")
    throw new Error("Output was not restored.");
  await NodeFSP.writeFile(NodePath.join(root, "b/input.txt"), "version-b");
  const changed = await run("b");
  console.log("Changed input:\n" + changed);
  if (
    changed.includes("cache hit") ||
    (await NodeFSP.readFile(NodePath.join(root, "b/output.txt"), "utf8")) !== "version-b"
  )
    throw new Error("Changed input reused stale output.");
  await NodeFSP.rm(NodePath.join(root, "a/node_modules"), { recursive: true, force: true });
  console.log("Original input after competing writer:\n" + (await run("a")));
  console.log(
    "PASS: authenticated upload, cold-checkout restoration, input validation, and anonymous-write rejection.",
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
