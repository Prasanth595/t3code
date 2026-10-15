// @effect-diagnostics nodeBuiltinImport:off - The factory runs commands as detached process groups, which Node's child_process exposes and ProcessRunner does not.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";

/**
 * Runs commands the way softfac does: a known environment, a hard time limit
 * that kills the whole process tree, and only the end of the output kept.
 *
 * POSIX only: it relies on /bin/sh, process groups and negative-pid kill.
 * `ProcessRunner` cannot do this (see factory/docs/design.md, open question 2),
 * so this module uses `node:child_process` directly and imports no T3 code.
 */

/**
 * Names copied from the server's environment, besides `LC_*`. This is defence
 * in depth, not a sandbox: code running as the same user can still read the
 * token file and ~/.ssh.
 */
export const INHERITED_ENV: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TERM",
];

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TAIL_BYTES = 16 * 1024;
export const DEFAULT_TERM_GRACE_MS = 10_000;
/** A process that left the group may still hold the pipe; do not wait long for it. */
const DRAIN_WAIT_MS = 2_000;

export class RunSpawnError extends Schema.TaggedError<RunSpawnError>()("RunSpawnError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to spawn ${this.command}`;
  }
}

export interface RunInput {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /** Run `command` as a /bin/sh script; `args` become its positional parameters ($0, $1, …). */
  readonly shell?: boolean;
  readonly cwd?: string;
  /** Added after the inherited allowlist; may override an inherited name. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default 30 minutes (softfac's gate default). */
  readonly timeoutMs?: number;
  /** Default 16 KiB. */
  readonly tailBytes?: number;
  /** How long after SIGTERM to send SIGKILL. Default 10_000. Exists so a test can be fast. */
  readonly termGraceMs?: number;
}

export interface RunResult {
  /** Node's exit code; null when the process ended by a signal (including after a timeout). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The last `tailBytes` of stdout and stderr interleaved, decoded as UTF-8. */
  readonly tail: string;
}

/**
 * Keeps the end of a byte stream. Memory stays under about twice the cap:
 * the front is dropped down to the cap only once the buffer passes twice it.
 */
class Tail {
  private buf = Buffer.alloc(0);
  private dropped = false;

  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 2 * this.cap) this.trim();
  }

  finish(): string {
    this.trim();
    let start = 0;
    // A cut inside a character loses that character instead of becoming U+FFFD.
    if (this.dropped) {
      while (start < this.buf.length && (this.buf[start]! & 0xc0) === 0x80) start++;
    }
    return new TextDecoder().decode(this.buf.subarray(start));
  }

  private trim(): void {
    if (this.buf.length > this.cap) {
      this.buf = this.buf.subarray(this.buf.length - this.cap);
      this.dropped = true;
    }
  }
}

const buildEnv = (extra: Readonly<Record<string, string>> | undefined): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(globalThis.process.env)) {
    if (value === undefined) continue;
    if (INHERITED_ENV.includes(name) || name.startsWith("LC_")) env[name] = value;
  }
  return { ...env, ...extra };
};

export const run = (input: RunInput): Effect.Effect<RunResult, RunSpawnError> =>
  Effect.gen(function* () {
    const args = input.args ?? [];
    const tail = new Tail(input.tailBytes ?? DEFAULT_TAIL_BYTES);

    // One pipe for both streams: Node cannot hand one pipe to two fds, so the
    // wrapper shell merges stderr into stdout. /bin/sh is absolute because the
    // caller may override PATH.
    const script = input.shell
      ? ["-c", `exec 2>&1\n${input.command}`, ...args]
      : ["-c", 'exec 2>&1\nexec "$0" "$@"', input.command, ...args];

    const exited = Deferred.makeUnsafe<
      readonly [number | null, NodeJS.Signals | null],
      RunSpawnError
    >();
    const closed = Deferred.makeUnsafe<void>();

    const child = NodeChildProcess.spawn("/bin/sh", script, {
      cwd: input.cwd,
      env: buildEnv(input.env),
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    child.once("error", (cause) =>
      Deferred.doneUnsafe(exited, Exit.fail(new RunSpawnError({ command: input.command, cause }))),
    );
    child.once("exit", (code, signal) =>
      Deferred.doneUnsafe(exited, Exit.succeed([code, signal] as const)),
    );
    child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stdout?.once("close", () => Deferred.doneUnsafe(closed, Exit.void));
    // No stdout (spawn failed): nothing to drain.
    if (!child.stdout) Deferred.doneUnsafe(closed, Exit.void);

    const pid = child.pid;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        globalThis.process.kill(-pid, signal);
      } catch {
        // ESRCH: the group is already gone.
      }
    };

    const body = Effect.gen(function* () {
      let timedOut = false;
      let outcome = yield* Deferred.await(exited).pipe(
        Effect.timeoutOption(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      );
      if (outcome._tag === "None") {
        timedOut = true;
        killGroup("SIGTERM");
        outcome = yield* Deferred.await(exited).pipe(
          Effect.timeoutOption(input.termGraceMs ?? DEFAULT_TERM_GRACE_MS),
        );
        if (outcome._tag === "None") {
          killGroup("SIGKILL");
        }
      }
      const [exitCode] = outcome._tag === "Some" ? outcome.value : yield* Deferred.await(exited);

      // Nothing the command started may outlive it. This also closes pipe ends
      // a stray background process still held.
      killGroup("SIGKILL");
      const drained = yield* Deferred.await(closed).pipe(Effect.timeoutOption(DRAIN_WAIT_MS));
      if (drained._tag === "None") child.stdout?.destroy();

      return { exitCode, timedOut, tail: tail.finish() } satisfies RunResult;
    });

    return yield* body.pipe(Effect.onInterrupt(() => Effect.sync(() => killGroup("SIGKILL"))));
  });
