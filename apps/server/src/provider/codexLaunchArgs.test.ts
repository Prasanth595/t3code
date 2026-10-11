import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe.each([
  ["app-server", codexAppServerArgs],
  ["exec", codexExecLaunchArgs],
] as const)("local Codex %s launch", (_name, buildArgs) => {
  it("refuses a cloud task request instead of ignoring it or choosing a fallback", () => {
    for (const launchArgs of ["cloud exec --env remote", '--strict-config "cloud" "exec"']) {
      NodeAssert.throws(
        () => buildArgs(resolveCodexLaunchArgs(launchArgs, {})),
        /Codex Cloud task execution is not supported by T3's local Codex runtime/,
      );
    }
    NodeAssert.throws(
      () =>
        buildArgs(
          resolveCodexLaunchArgs("--strict-config", { T3CODE_CODEX_LAUNCH_ARGS: "cloud exec" }),
        ),
      /Codex Cloud task execution is not supported by T3's local Codex runtime/,
    );
  });
});

it("keeps cloud command text inside a configuration value as data", () => {
  const launchArgs = '--config developer_instructions="Never run cloud exec"';
  const flags = ["--config", "developer_instructions=Never run cloud exec"];
  NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs), ["app-server", ...flags]);
  NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), flags);
});

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
