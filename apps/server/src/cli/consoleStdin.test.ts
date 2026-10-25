// @effect-diagnostics nodeBuiltinImport:off - Exercises the raw console descriptors used before runtime startup.
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import { expect, it, vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { attachConsoleStdin, interactiveStdin } from "./consoleStdin.ts";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFS>()),
}));

vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeTty>()),
}));

function setup(mode: number) {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const marker = process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
  vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("win32");
  process.env.T3CODE_DESKTOP_CLI_LAUNCHER = "1";
  vi.spyOn(NodeFS, "fstatSync").mockReturnValue(
    Object.assign(NodeFS.statSync(import.meta.filename), { mode }),
  );
  vi.spyOn(NodeFS, "openSync").mockReturnValue(42);
  vi.spyOn(NodeFS, "closeSync").mockImplementation(() => {});
  vi.spyOn(NodeTty, "isatty").mockImplementation((fd) => fd === 1 || fd === 42);
  vi.spyOn(NodeTty, "ReadStream").mockImplementation(
    class {
      readonly isTTY = true;
    } as unknown as typeof NodeTty.ReadStream,
  );
  return {
    [Symbol.dispose]() {
      Object.defineProperty(process, "stdin", stdin);
      if (marker === undefined) delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
      else process.env.T3CODE_DESKTOP_CLI_LAUNCHER = marker;
      vi.restoreAllMocks();
    },
  };
}

it("recovers terminal input when Electron leaves an open non-TTY character device on stdin", () => {
  using _state = setup(NodeFS.constants.S_IFCHR);

  expect(attachConsoleStdin()).toBe(42);
  expect(NodeFS.openSync).toHaveBeenCalledWith("\\\\.\\CONIN$", "r+");
  expect(process.stdin.isTTY).toBe(true);
  expect(interactiveStdin()).toBe(42);
  expect(process.env.T3CODE_DESKTOP_CLI_LAUNCHER).toBeUndefined();
});

it.each([
  ["pipe", NodeFS.constants.S_IFIFO],
  ["file", NodeFS.constants.S_IFREG],
])("preserves stdin redirected from a %s", (_name, mode) => {
  using _state = setup(mode);
  const stdin = process.stdin;

  expect(attachConsoleStdin()).toBeUndefined();
  expect(NodeFS.openSync).not.toHaveBeenCalled();
  expect(process.stdin).toBe(stdin);
});

it("keeps working terminal input", () => {
  using _state = setup(NodeFS.constants.S_IFCHR);
  vi.mocked(NodeTty.isatty).mockReturnValue(true);
  const stdin = process.stdin;

  expect(attachConsoleStdin()).toBeUndefined();
  expect(NodeFS.openSync).not.toHaveBeenCalled();
  expect(process.stdin).toBe(stdin);
});

it("still recovers closed stdin", () => {
  using _state = setup(0);
  vi.mocked(NodeFS.fstatSync).mockImplementation(() => {
    throw new Error("EBADF");
  });

  expect(attachConsoleStdin()).toBe(42);
  expect(process.stdin.isTTY).toBe(true);
});

it.each(["non-launcher", "redirected output", "other platform"])(
  "leaves stdin alone for %s runs",
  (scenario) => {
    using _state = setup(NodeFS.constants.S_IFCHR);
    if (scenario === "non-launcher") delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
    if (scenario === "redirected output") vi.mocked(NodeTty.isatty).mockReturnValue(false);
    if (scenario === "other platform") {
      vi.mocked(HostProcess.Platform.defaultValue).mockReturnValue("linux");
    }

    expect(attachConsoleStdin()).toBeUndefined();
    expect(NodeFS.openSync).not.toHaveBeenCalled();
  },
);
