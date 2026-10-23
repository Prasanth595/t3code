import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AntigravityRuntimeTemp from "./AntigravityRuntimeTemp.ts";

it.layer(NodeServices.layer)("AntigravityRuntimeTemp", (it) => {
  it.effect("hands off slow cleanup, bounds deletion, and preserves live siblings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-" });
      const directory = path.join(root, "gc");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let starts = 0;
      const cleanup = yield* AntigravityRuntimeTemp.make(directory).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              starts += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* spawner.spawn(command);
            }),
          ),
        ),
      );
      const liveScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(liveScope, exit));
      const live = yield* cleanup.makeDirectory.pipe(Effect.provideService(Scope.Scope, liveScope));
      yield* fs.writeFileString(path.join(live, "keep.txt"), "live");
      yield* cleanup.makeDirectory.pipe(Effect.scoped);
      yield* Deferred.await(entered);
      // More completed requests do not create fibers or child processes behind the stalled delete.
      for (let index = 0; index < 7; index += 1) {
        yield* cleanup.makeDirectory.pipe(Effect.scoped);
      }
      expect(yield* cleanup.makeDirectory.pipe(Effect.scoped, Effect.flip)).toBeInstanceOf(
        AntigravityRuntimeTemp.BacklogFullError,
      );
      expect(starts).toBe(1);
      expect((yield* fs.readDirectory(directory)).length).toBe(9);
      expect(yield* fs.readFileString(path.join(live, "keep.txt"))).toBe("live");
      yield* Deferred.succeed(release, undefined);
      yield* cleanup.drain;
      expect(yield* fs.readDirectory(directory)).toEqual([path.basename(live)]);
      yield* cleanup.makeDirectory.pipe(Effect.scoped);
      yield* Scope.close(liveScope, Exit.void);
      yield* cleanup.drain;
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("retains failed deletions for retry without failing the releasing request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-retry-" });
      const finished = yield* Queue.unbounded<void>();
      let fail = true;
      const cleanup = yield* AntigravityRuntimeTemp.make(root).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Queue.offer(finished, undefined));
              return yield* spawner.spawn(
                fail && command._tag === "StandardCommand"
                  ? ChildProcess.make(
                      command.command,
                      ["--eval", "process.exit(1)"],
                      command.options,
                    )
                  : command,
              );
            }),
          ),
        ),
      );
      const pending = yield* cleanup.makeDirectory.pipe(Effect.scoped);
      yield* Queue.take(finished);
      expect(yield* fs.exists(pending)).toBe(true);
      fail = false;
      yield* cleanup.drain;
      expect(yield* fs.exists(pending)).toBe(false);
      expect(yield* fs.readDirectory(path.dirname(pending))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts stalled cleanup on shutdown and recovers the directory on restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-restart-" });
      const directory = path.join(root, "gc");
      const serviceScope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const children: ChildProcessSpawner.ChildProcessHandle[] = [];
      const first = yield* AntigravityRuntimeTemp.make(directory).pipe(
        Effect.provideService(Scope.Scope, serviceScope),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag !== "StandardCommand")
                return yield* Effect.die("Unexpected pipeline");
              const child = yield* spawner.spawn(
                ChildProcess.make(command.command, ["--eval", "process.stdin.resume()"], {
                  ...command.options,
                  stdin: "pipe",
                }),
              );
              children.push(child);
              yield* Deferred.succeed(entered, undefined);
              return child;
            }),
          ),
        ),
      );
      const pending = yield* first.makeDirectory.pipe(Effect.scoped);
      yield* Deferred.await(entered);
      yield* Scope.close(serviceScope, Exit.void);
      expect(children).toHaveLength(1);
      for (const child of children) expect(yield* child.isRunning).toBe(false);
      expect(yield* fs.exists(pending)).toBe(true);
      const second = yield* AntigravityRuntimeTemp.make(directory);
      yield* second.drain;
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
