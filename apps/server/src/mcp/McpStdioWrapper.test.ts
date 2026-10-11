import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { McpStdioWrapperConfigError, resolveMcpStdioWrapper } from "./McpStdioWrapper.ts";

const makeFile = Effect.fn(function* (name: string, mode: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-stdio-wrapper-" });
  const file = path.join(directory, name);
  yield* fs.writeFileString(file, "#!/bin/sh\n");
  yield* fs.chmod(file, mode);
  return { directory, file };
});

const failureOf = (value: string) =>
  resolveMcpStdioWrapper(value).pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.instanceOf(error, McpStdioWrapperConfigError);
      // The message names the setting, never the operator's path or arguments.
      assert.include(error.message, "T3CODE_MCP_STDIO_WRAPPER");
      assert.notInclude(error.message, "private");
      return error.reason;
    }),
  );

it.layer(NodeServices.layer)("resolveMcpStdioWrapper", (it) => {
  it.effect("splits an executable path from fixed arguments without a shell", () =>
    Effect.gen(function* () {
      const { file } = yield* makeFile("mcp-wrapper", 0o700);
      assert.deepEqual(yield* resolveMcpStdioWrapper(`${file} --audit "two words" '' $HOME`), {
        command: file,
        args: ["--audit", "two words", "", "$HOME"],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses values that cannot name an absolute executable", () =>
    Effect.gen(function* () {
      const { directory, file } = yield* makeFile("private-not-executable", 0o600);
      assert.equal(yield* failureOf("   "), "empty");
      assert.equal(yield* failureOf("private-wrapper --audit"), "relative");
      assert.equal(yield* failureOf("./private-wrapper"), "relative");
      assert.equal(yield* failureOf(`${directory}/private-missing`), "notExecutable");
      assert.equal(yield* failureOf(directory), "notExecutable");
      assert.equal(yield* failureOf(file), "notExecutable");
    }).pipe(Effect.scoped),
  );

  it.effect("accepts only PATHEXT executables on Windows", () =>
    Effect.gen(function* () {
      const exe = yield* makeFile("mcp-wrapper.exe", 0o600);
      const bare = yield* makeFile("mcp-wrapper", 0o700);
      const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATHEXT: ".EXE;.CMD" }),
        );
      assert.deepEqual(yield* onWindows(resolveMcpStdioWrapper(exe.file)), {
        command: exe.file,
        args: [],
      });
      // An execute bit means nothing there; a file without a PATHEXT extension cannot launch.
      assert.equal(yield* onWindows(failureOf(bare.file)), "notExecutable");
    }).pipe(Effect.scoped),
  );
});
