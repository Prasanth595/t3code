import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const ProcessIdentity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });

const RelayClientEntry = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.String,
  stateDir: Schema.String,
  owner: ProcessIdentity,
});
type RelayClientEntry = typeof RelayClientEntry.Type;
const RelayClientEntryJson = Schema.fromJsonString(RelayClientEntry);
const decodeEntry = Schema.decodeUnknownOption(RelayClientEntryJson);
const encodeEntry = Schema.encodeEffect(RelayClientEntryJson);

export class RelayClientLedger extends Context.Service<
  RelayClientLedger,
  {
    /** Records a started relay client; the returned effect forgets it. */
    readonly track: (client: { readonly pid: number }) => Effect.Effect<Effect.Effect<void>>;
  }
>()("t3/cloud/RelayClientLedger") {}

const ENTRY_DIRECTORY = "relay-clients";
const ENTRY_FILE = /^\d+\.json$/;
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;

interface ObservedProcess {
  readonly pid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// `ps -o lstart` prints e.g. `Sat Sep  6 20:51:57 2026`; C locale and UTC keep it stable.
const DARWIN_PS_LINE = /^\s*(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") throw cause;
  }
};

export const make = Effect.fn("RelayClientLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(input.stateDir, ENTRY_DIRECTORY);
  const recordable = platform === "linux" || platform === "darwin";

  const observeLinux = Effect.fn("RelayClientLedger.observeLinux")(function* (pid: number) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (startTime === undefined) return undefined;
    const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
    return {
      pid,
      startTime,
      command: cmdline.replace(/\0$/, "").replaceAll("\0", " "),
      zombie: fields[0] === "Z",
    } satisfies ObservedProcess;
  });

  const observeDarwin = (pid: number) =>
    spawner
      .string(
        ChildProcess.make("/bin/ps", ["-ww", "-o", "pid=,stat=,lstart=,args=", "-p", String(pid)], {
          env: { LC_ALL: "C", TZ: "UTC" },
          extendEnv: true,
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.map((output) =>
          output.split("\n").flatMap((line): ReadonlyArray<ObservedProcess> => {
            const match = DARWIN_PS_LINE.exec(line);
            if (match === null || Number(match[1]) !== pid) return [];
            return [
              {
                pid,
                zombie: match[2]!.startsWith("Z"),
                startTime: match[3]!,
                command: match[4]!.trimEnd(),
              },
            ];
          }),
        ),
        Effect.map((found) => found[0]),
      );

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "darwin") {
      return observeDarwin(pid).pipe(Effect.orElseSucceed(() => undefined));
    }
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - Missing process observations are undefined, not void.
    return Effect.succeed(undefined);
  };

  const sameProcess = (
    observed: ObservedProcess | undefined,
    identity: { readonly startTime: string; readonly command?: string },
  ) =>
    observed !== undefined &&
    !observed.zombie &&
    observed.startTime === identity.startTime &&
    (identity.command === undefined || observed.command === identity.command);

  const ownerPid = input.ownerPid ?? process.pid;
  const ownerProcess = yield* observe(ownerPid);
  const owner =
    ownerProcess === undefined ? undefined : { pid: ownerPid, startTime: ownerProcess.startTime };

  const track: RelayClientLedger["Service"]["track"] = Effect.fn("RelayClientLedger.track")(
    function* (client) {
      if (!recordable) return Effect.void;
      const observed = yield* observe(client.pid);
      if (owner === undefined || observed === undefined || observed.zombie) {
        yield* Effect.logWarning(
          "Could not record the relay client; it will keep running if this server crashes",
          { pid: client.pid },
        );
        return Effect.void;
      }
      const entryPath = path.join(directory, `${client.pid}.json`);
      const entry: RelayClientEntry = {
        version: 1,
        pid: observed.pid,
        startTime: observed.startTime,
        command: observed.command,
        stateDir: input.stateDir,
        owner,
      };
      yield* writeFileStringAtomically({
        filePath: entryPath,
        contents: yield* encodeEntry(entry),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return fs
        .remove(entryPath, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not forget a stopped relay client", { cause }),
          ),
        );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record the relay client process", { cause }).pipe(
        Effect.as(Effect.void),
      ),
    ),
  );

  const stopOrphan = Effect.fn("RelayClientLedger.stopOrphan")(function* (entry: RelayClientEntry) {
    if (!sameProcess(yield* observe(entry.pid), entry)) return true;
    yield* Effect.logInfo("Stopping a relay client left by a previous T3 Code server", {
      pid: entry.pid,
    });
    for (const name of ["SIGTERM", "SIGKILL"] as const) {
      if (!sameProcess(yield* observe(entry.pid), entry)) return true;
      signal(entry.pid, name);
      for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS; attempt++) {
        if (!sameProcess(yield* observe(entry.pid), entry)) return true;
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
    }
    return !sameProcess(yield* observe(entry.pid), entry);
  });

  const reapEntry = Effect.fn("RelayClientLedger.reapEntry")(
    function* (entryPath: string) {
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry) && entry.value.stateDir === input.stateDir) {
        const owner = yield* observe(entry.value.owner.pid);
        if (
          sameProcess(owner, entry.value.owner) ||
          (owner === undefined && processExists(entry.value.owner.pid))
        )
          return;
        if (!(yield* stopOrphan(entry.value))) return;
      }
      yield* fs.remove(entryPath, { force: true });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not clean up a recorded relay client", { cause }),
    ),
  );

  const reapOrphans = Effect.gen(function* () {
    if (!recordable) return;
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE.test(name)),
      (name) => reapEntry(path.join(directory, name)),
      { concurrency: "unbounded", discard: true },
    );
  });

  return { track, reapOrphans };
});

export const layer = (input: { readonly stateDir: string }) =>
  Layer.effect(
    RelayClientLedger,
    Effect.gen(function* () {
      const ledger = yield* make(input);
      yield* ledger.reapOrphans.pipe(Effect.forkScoped);
      return RelayClientLedger.of({ track: ledger.track });
    }),
  );
