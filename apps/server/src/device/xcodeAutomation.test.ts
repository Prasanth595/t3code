// @effect-diagnostics nodeBuiltinImport:off - runs the generated host script against fake Xcode tools.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { xcodeAutomationWarningScript } from "./xcodeAutomation.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

const warningFor = (serviceHub: string | null) =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-xcode-"));
    try {
      const bin = NodePath.join(root, "bin");
      const developer = NodePath.join(root, "Xcode.app/Contents/Developer");
      const resources = NodePath.join(
        root,
        "Xcode.app/Contents/SharedFrameworks/DVTInstrumentsFoundation.framework/Resources",
      );
      await NodeFSP.mkdir(bin, { recursive: true });
      await NodeFSP.mkdir(developer, { recursive: true });
      await NodeFSP.mkdir(resources, { recursive: true });
      const tool = (name: string, body: string, dir = bin) =>
        NodeFSP.writeFile(NodePath.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      await tool("xcode-select", `echo ${developer}`);
      await tool("xcodebuild", "printf 'Xcode 26.6\\nBuild version 17F113\\n'");
      await tool("sw_vers", "echo 27.2");
      if (serviceHub !== null) await tool("DTServiceHub", serviceHub, resources);
      const result = await exec(
        process.execPath,
        [
          "-e",
          xcodeAutomationWarningScript +
            "\nprocess.stdout.write(JSON.stringify(xcodeAutomationWarning()));",
        ],
        { env: { PATH: `${bin}:/usr/bin:/bin` } },
      );
      return JSON.parse(result.stdout) as string | null;
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

describe("xcodeAutomationWarning", () => {
  it.effect("names both versions when macOS kills Xcode's service hub at launch", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      expect(yield* warningFor("kill -9 $$")).toBe(
        "Xcode 26.6 is too old for macOS 27.2, so agents cannot tap, type, or read the screen in iOS Simulators. Update Xcode.",
      );
    }),
  );

  it.effect("stays quiet when the service hub runs or cannot be found", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      expect(yield* warningFor("exit 1")).toBeNull();
      expect(yield* warningFor(null)).toBeNull();
    }),
  );
});
