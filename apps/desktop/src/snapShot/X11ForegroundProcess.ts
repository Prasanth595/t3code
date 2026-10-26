// @effect-diagnostics nodeBuiltinImport:off -- This platform boundary isolates fatal Xlib errors in a Node subprocess.

import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

const decodeWindow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.Number,
        title: Schema.String,
        bounds: Schema.Struct({
          x: Schema.Number,
          y: Schema.Number,
          width: Schema.Number,
          height: Schema.Number,
        }),
        processId: Schema.Number,
        appName: Schema.String,
      }),
    ),
  ),
);

export function readX11ForegroundProcess(workerPath: string) {
  return new Promise<Exclude<ReturnType<typeof decodeWindow>, null> | undefined>(
    (resolve, reject) => {
      NodeChildProcess.execFile(
        process.execPath,
        [workerPath],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => {
          if (error) {
            reject(new Error("X11 foreground window lookup failed.", { cause: error }));
            return;
          }
          try {
            resolve(decodeWindow(stdout) ?? undefined);
          } catch (cause) {
            reject(new Error("Invalid X11 foreground window response.", { cause }));
          }
        },
      );
    },
  );
}
