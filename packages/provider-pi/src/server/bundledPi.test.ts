// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolvePiCommand, writeBundledPiLaunchers } from "./bundledPi.ts";

const miraEnv = { MIRA_BASE_URL: "http://127.0.0.1:9/v1", MIRA_API_KEY: "mira_test" };

it("runs the bundled Pi CLI when no custom binary is configured", () => {
  const command = resolvePiCommand(undefined, ["--version"], {});
  expect(command.command).toBe(process.execPath);
  expect(command.env.ELECTRON_RUN_AS_NODE).toBe("1");
  const output = NodeChildProcess.execFileSync(command.command, [...command.args], {
    env: { ...process.env, ...command.env },
  });
  expect(output.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
});

it("registers the Mira provider for sessions once an account is connected", () => {
  const command = resolvePiCommand(undefined, ["--mode", "json", "--list-models", "mira"], miraEnv);
  // Pi prints the model table on stderr.
  const result = NodeChildProcess.spawnSync(command.command, [...command.args], {
    env: { ...process.env, ...command.env },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).toMatch(/^mira\s+mira\s/m);
  expect(resolvePiCommand("/opt/pi", ["--version"], miraEnv).args).toEqual(["--version"]);
  expect(resolvePiCommand("/opt/pi", ["--mode", "rpc"], {}).args).toEqual(["--mode", "rpc"]);
});

it("keeps a configured binary path", () => {
  expect(resolvePiCommand("/opt/pi", ["--mode", "rpc"], {})).toEqual({
    command: "/opt/pi",
    args: ["--mode", "rpc"],
    env: {},
  });
});

it.effect("writes a terminal launcher that starts the bundled CLI", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-launcher-"));
    try {
      expect(writeBundledPiLaunchers(directory, platform)).toBe(directory);
      const output =
        platform === "win32"
          ? NodeChildProcess.execFileSync("cmd.exe", ["/d", "/c", "pi.cmd", "--version"], {
              cwd: directory,
            })
          : NodeChildProcess.execFileSync(NodePath.join(directory, "pi"), ["--version"]);
      expect(output.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }),
);
