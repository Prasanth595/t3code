// @effect-diagnostics nodeBuiltinImport:off -- Real temporary worker files exercise the subprocess boundary.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { readX11ForegroundProcess } from "./X11ForegroundProcess.ts";

it("contains a fatal native lookup exit and allows the next capture", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-x11-"));
  try {
    const workerPath = NodePath.join(directory, "lookup.mjs");
    await NodeFSP.writeFile(workerPath, 'process.stderr.write("BadWindow"); process.exit(1);');
    const error = await readX11ForegroundProcess(workerPath).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "X11 foreground window lookup failed.",
      cause: { code: 1, message: expect.stringContaining("BadWindow") },
    });

    const window = {
      id: 42,
      title: "Editor",
      bounds: { x: -800, y: 20, width: 800, height: 600 },
      processId: 123,
      appName: "Text Editor",
    };
    await NodeFSP.writeFile(
      workerPath,
      `process.stdout.write(${JSON.stringify(JSON.stringify(window))});`,
    );
    expect(await readX11ForegroundProcess(workerPath)).toEqual(window);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("distinguishes no focused window from a malformed helper response", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-x11-"));
  try {
    const workerPath = NodePath.join(directory, "lookup.mjs");
    await NodeFSP.writeFile(workerPath, 'process.stdout.write("null");');
    expect(await readX11ForegroundProcess(workerPath)).toBeUndefined();
    await NodeFSP.writeFile(workerPath, 'process.stdout.write("{}");');
    await expect(readX11ForegroundProcess(workerPath)).rejects.toThrow(
      "Invalid X11 foreground window response.",
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
