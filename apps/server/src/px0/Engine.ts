import {
  Px0DiffResult,
  Px0Error,
  Px0FileResult,
  Px0FindResults,
  Px0GutterResult,
  Px0MetaResult,
  Px0OutlineResult,
  Px0SearchResult,
  Px0TreeResult,
  type Px0DiffInput,
  type Px0FileInput,
  type Px0FindInput,
  type Px0MetaInput,
  type Px0OutlineInput,
  type Px0SearchInput,
  type Px0TreeInput,
  type Px0TableInput,
  type Px0TableResult,
} from "@t3tools/contracts";
import { Platform as HostProcessPlatform } from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { Px0 } from "@t3tools/px0-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Runs a headless px0 code-viewer per workspace root and proxies its read API.
 *
 * px0 is a bundled Go binary that indexes one root and answers fast
 * `/api/tree`, `/api/file`, `/api/table`, `/api/search`, `/api/outline`,
 * `/api/diff`, and `/api/gutter` requests. T3 spawns it on a reserved loopback port and talks to
 * it through the vendored `@t3tools/px0-sdk` client, then exposes the results
 * over the typed WebSocket transport.
 */

const PX0_DEFAULT_BINARY = "px0";

/** Drop `undefined` entries so optional px0 args satisfy `exactOptionalPropertyTypes`. */
const omitUndefined = <const T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T as T[K] extends undefined ? never : K]: NonNullable<T[K]>;
  };

export class Px0Engine extends Context.Service<
  Px0Engine,
  {
    readonly meta: (input: Px0MetaInput) => Effect.Effect<Px0MetaResult, Px0Error, Scope.Scope>;
    readonly tree: (input: Px0TreeInput) => Effect.Effect<Px0TreeResult, Px0Error, Scope.Scope>;
    readonly find: (input: Px0FindInput) => Effect.Effect<Px0FindResults, Px0Error, Scope.Scope>;
    readonly file: (input: Px0FileInput) => Effect.Effect<Px0FileResult, Px0Error, Scope.Scope>;
    readonly table: (input: Px0TableInput) => Effect.Effect<Px0TableResult, Px0Error, Scope.Scope>;
    readonly search: (
      input: Px0SearchInput,
    ) => Effect.Effect<Px0SearchResult, Px0Error, Scope.Scope>;
    readonly outline: (
      input: Px0OutlineInput,
    ) => Effect.Effect<Px0OutlineResult, Px0Error, Scope.Scope>;
    readonly diff: (input: Px0DiffInput) => Effect.Effect<Px0DiffResult, Px0Error, Scope.Scope>;
    readonly gutter: (input: Px0DiffInput) => Effect.Effect<Px0GutterResult, Px0Error, Scope.Scope>;
  }
>()("t3/px0/Engine/Px0Engine") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* Px0EngineMake() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* Net.NetService;
  const hostPlatform = yield* HostProcessPlatform;

  // Engines outlive any single request, so their children are owned by a scope
  // that only closes when the service (and server) tears down.
  const engineScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(engineScope, Exit.void));
  const clientsRef = yield* Ref.make<ReadonlyMap<string, Px0>>(new Map());
  const spawnSemaphore = yield* Semaphore.make(1);

  const spawnClient = (cwd: string): Effect.Effect<Px0, Px0Error> =>
    Effect.gen(function* () {
      // Resolved per spawn so an override (e.g. a bundled or test binary) takes
      // effect without rebuilding the service.
      const binaryPath = process.env["PX0_BINARY"] ?? PX0_DEFAULT_BINARY;
      const port = yield* net
        .reserveLoopbackPort()
        .pipe(Effect.mapError((cause) => new Px0Error({ operation: "spawn", cwd, cause })));
      const args = [
        "-host",
        "127.0.0.1",
        "-port",
        String(port),
        "-no-open",
        "-no-agent",
        "-no-telemetry",
        cwd,
      ];
      const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {}).pipe(
        Effect.mapError((cause) => new Px0Error({ operation: "spawn", cwd, cause })),
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            cwd,
          }),
        )
        .pipe(Effect.mapError((cause) => new Px0Error({ operation: "spawn", cwd, cause })));
      const terminate =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminate.pipe(Effect.ignore));
      // Drain the child's streams so a chatty px0 cannot block on a full pipe.
      yield* Effect.forkScoped(child.stdout.pipe(Stream.runDrain));
      yield* Effect.forkScoped(child.stderr.pipe(Stream.runDrain));

      const client = new Px0({ url: `http://127.0.0.1:${port}/` });
      yield* Effect.tryPromise({
        try: () => client.ready({ timeout: 10_000 }),
        catch: (cause) => new Px0Error({ operation: "spawn", cwd, cause }),
      });
      return client;
    }).pipe(Effect.provideService(Scope.Scope, engineScope));

  const ensure = (cwd: string): Effect.Effect<Px0, Px0Error, Scope.Scope> =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(clientsRef);
      const cached = existing.get(cwd);
      if (cached) return cached;
      return yield* Semaphore.withPermit(spawnSemaphore)(
        Effect.gen(function* () {
          const current = yield* Ref.get(clientsRef);
          const cachedNow = current.get(cwd);
          if (cachedNow) return cachedNow;
          const client = yield* spawnClient(cwd);
          yield* Ref.update(clientsRef, (map) => new Map(map).set(cwd, client));
          return client;
        }),
      );
    });

  const call = <A>(
    operation: string,
    cwd: string,
    run: (client: Px0) => Promise<A>,
  ): Effect.Effect<A, Px0Error, Scope.Scope> =>
    Effect.gen(function* () {
      const client = yield* ensure(cwd);
      return yield* Effect.tryPromise({
        try: () => run(client),
        catch: (cause) => new Px0Error({ operation, cwd, cause }),
      });
    });

  return Px0Engine.of({
    meta: (input) =>
      call("meta", input.cwd, (c) => c.meta()).pipe(
        Effect.map((m): Px0MetaResult => ({
          root: m.root,
          name: m.name,
          files: m.files,
          ready: m.ready,
          git: m.git,
          gitChanges: m.gitChanges,
          gitFiles: m.gitFiles,
          lspServers: m.lspServers,
          version: m.version,
        })),
      ),
    tree: (input) =>
      call("tree", input.cwd, (c) => c.tree(input.dir)).pipe(
        Effect.map((children): Px0TreeResult => ({
          dir: input.dir,
          children: children.map((child) => ({
            name: child.name,
            path: child.path,
            dir: child.dir,
            size: child.size,
          })),
        })),
      ),
    find: (input) =>
      call("find", input.cwd, (c) => c.find(input.q, omitUndefined({ limit: input.limit }))).pipe(
        Effect.map((results): Px0FindResults => ({ results })),
      ),
    file: (input) =>
      call("file", input.cwd, (c) =>
        c.file(input.path, omitUndefined({ start: input.start, count: input.count })),
      ).pipe(
        Effect.map((file): Px0FileResult =>
          "image" in file
            ? {
                path: file.path,
                size: file.size,
                image: true,
                lang: "",
                total: 0,
                maxCols: 0,
                start: 0,
                lines: [],
                exact: true,
                refine: false,
                markdown: false,
                diffAvailable: false,
              }
            : {
                path: file.path,
                lang: file.lang,
                total: file.total,
                maxCols: file.maxCols,
                start: file.start,
                lines: file.lines,
                size: file.size,
                exact: file.exact,
                refine: file.refine,
                markdown: file.markdown,
                diffAvailable: file.diffAvailable,
                lsp: file.lsp,
              },
        ),
      ),
    table: (input) => call("table", input.cwd, (c) => c.table(input.path)),
    search: (input) =>
      call("search", input.cwd, (c) =>
        c.search(
          input.q,
          omitUndefined({
            regex: input.re,
            caseSensitive: input.case,
            word: input.word,
            glob: input.glob,
          }),
        ),
      ),
    outline: (input) =>
      call("outline", input.cwd, (c) => c.outline(input.path)).pipe(
        Effect.map((symbols): Px0OutlineResult => ({ path: input.path, symbols })),
      ),
    diff: (input) =>
      call("diff", input.cwd, (c) => c.diff(input.path)).pipe(
        Effect.map((d): Px0DiffResult => ({ path: d.path, diff: d.diff, available: d.available })),
      ),
    gutter: (input) => call("gutter", input.cwd, (c) => c.gutter(input.path)),
  });
});

export const layer = Layer.effect(Px0Engine, make);
