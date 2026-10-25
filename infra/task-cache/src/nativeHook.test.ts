import { expect, it } from "vite-plus/test";
import { patchNativeCli } from "./nativeHook.ts";

it("wraps the native runner in a finally hook and patches only once", () => {
  const original =
    "\tconst exitCode = await run({\n\t\targs: rustCliArgs\n\t});\n\tprocess.exit(exitCode);";
  const patched = patchNativeCli(original);
  expect(patched).toContain("await startRunHook(command)");
  expect(patched).toContain("finally {\n\t\tawait finishRunHook?.();");
  expect(patched).toContain("process.exit(exitCode)");
  expect(patchNativeCli(patched)).toBe(patched);
});

it("rejects an unknown native entrypoint before changing it", () => {
  expect(() => patchNativeCli("changed upstream entrypoint")).toThrow(
    "Unsupported Vite+ entrypoint",
  );
});

it("leaves an unsupported CLI runnable when the machine preload is enabled", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-preload-"));
  try {
    const directory = path.join(root, "vite-plus/dist");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(directory, "bin.js"), 'console.log("unmodified CLI");');
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", new URL("./preload.mjs", import.meta.url).href, path.join(directory, "bin.js")],
      { env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(result.stdout.trim()).toBe("unmodified CLI");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
