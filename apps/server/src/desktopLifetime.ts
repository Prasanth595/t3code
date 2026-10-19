// @effect-diagnostics nodeBuiltinImport:off -- net.Socket reads the inherited pipe asynchronously.
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";

const watch = Effect.fn("DesktopLifetime.watch")(
  function* (fd: number) {
    const socket = yield* Effect.acquireRelease(
      Effect.try(() => new NodeNet.Socket({ fd, readable: true, writable: false })),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    yield* Effect.callback<void, Error>((resume) => {
      const onEnd = () => resume(Effect.void);
      socket.once("end", onEnd);
      // Keep handling errors until destruction, including errors after cancellation.
      socket.on("error", (error) => resume(Effect.fail(error)));
      socket.resume();
      return Effect.sync(() => socket.off("end", onEnd));
    });
    yield* Effect.logInfo("The desktop app exited; shutting down.", { fd });
    yield* Effect.sync(() => {
      // A real SIGTERM skips Node shutdown handlers on Windows.
      if (!process.emit("SIGTERM", "SIGTERM")) {
        process.kill(process.pid, "SIGTERM");
      }
    });
  },
  Effect.scoped,
  Effect.catch((cause) => Effect.logWarning("Cannot watch the desktop app's lifetime.", { cause })),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { desktopLifetimeFd } = yield* ServerConfig.ServerConfig;
    if (desktopLifetimeFd === undefined) return;
    yield* watch(desktopLifetimeFd).pipe(Effect.forkScoped);
  }),
);
