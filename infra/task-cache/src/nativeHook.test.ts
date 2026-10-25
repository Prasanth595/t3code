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
