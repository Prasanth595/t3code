import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

async function readJson(file) {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Optional repository integration; never changes the task runner's exit status.
export async function startRunHook(command, cwd = process.cwd()) {
  if (command !== "run") return;
  try {
    const configured = await readJson(
      NodePath.join(NodeOS.homedir(), ".config/vite-plus/run-hook.json"),
    );
    let root = cwd;
    while (true) {
      const manifest = await readJson(NodePath.join(root, "package.json"));
      let hook = manifest?.vitePlus?.runHook;
      if (!hook && configured?.rootMarker && configured?.module) {
        try {
          await NodeFSP.access(NodePath.join(root, configured.rootMarker));
          hook = configured.module;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (typeof hook === "string") {
        const integration = await import(NodeURL.pathToFileURL(NodePath.resolve(root, hook)).href);
        const finish = await integration.default({ root });
        return async () => {
          try {
            await finish?.();
          } catch {
            console.warn("[Vite+] Run hook failed to finish.");
          }
        };
      }
      const parent = NodePath.dirname(root);
      if (parent === root) return;
      root = parent;
    }
  } catch {
    console.warn("[Vite+] Run hook failed to start.");
  }
}
