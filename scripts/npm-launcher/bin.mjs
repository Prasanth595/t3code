// `dist/bin.mjs` of the `t3` npm package: the entry point that boot-service
// launchers installed before 0.0.41 run with Node to start a new version they
// just npm-installed. It forwards everything (arguments, stdio, the IPC
// channel the launcher talks over, signals, exit status) to the downloaded
// executable. The first server started this way rewrites the service unit to
// run the executable directly, so nothing depends on this file after one
// update.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";

const { ensureRuntime, runLauncher } = createRequire(import.meta.url)("../bin/runtime.cjs");

runLauncher(async () => {
  const executable = await ensureRuntime();
  const ipc = process.send !== undefined;
  const child = spawn(executable, process.argv.slice(2), {
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
  });
  const fail = (error) => {
    if (!error) return;
    process.stderr.write(`t3: ${error.message}\n`);
    child.kill("SIGTERM");
    process.exitCode = 1;
  };
  if (ipc) {
    process.on("message", (message) => {
      if (child.connected) child.send(message, fail);
    });
    child.on("message", (message) => {
      if (process.connected) process.send(message, fail);
    });
    process.on("disconnect", () => {
      if (child.connected) child.disconnect();
    });
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    fail(error);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] || 1)));
});
