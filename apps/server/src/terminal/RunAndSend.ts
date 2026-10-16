import * as NodeBuffer from "node:buffer";
import {
  CommandId,
  MessageId,
  TerminalRunAndSendError,
  ThreadId,
  type TerminalRunAndSendInput,
  type TerminalRunAndSendResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as TerminalManager from "./Manager.ts";

export class TerminalRunAndSend extends Context.Service<
  TerminalRunAndSend,
  {
    readonly run: (
      input: TerminalRunAndSendInput,
    ) => Effect.Effect<TerminalRunAndSendResult, TerminalRunAndSendError>;
  }
>()("t3/terminal/RunAndSend/TerminalRunAndSend") {}

const OUTPUT_LIMIT = 128 * 1024;
const RUN_LIMIT = 1024;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

type Completion = {
  readonly exitCode: number | null;
  readonly status:
    | "completed"
    | "cancelled"
    | "closed"
    | "exited_without_completion"
    | "timed_out"
    | "error";
};

// Keep framing in the byte stream: typed/echoed script text cannot be mistaken
// for a marker, and markers do not add or consume an output newline.
function commandScripts(command: string, token: string) {
  const start = `${token}:start`;
  const done = `${token}:done`;
  // Launch a child of the actual selected PowerShell executable. Closing its
  // redirected stdin delivers real EOF to native tools as well as cmdlets.
  const psCommand = `$global:LASTEXITCODE = $null; & { ${command}\n; $script:t3_ok = $? } | Out-Host; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $t3_ok) { exit 1 }`;
  const psEncoded = NodeBuffer.Buffer.from(psCommand, "utf16le").toString("base64");
  return {
    posix: `printf '\\033]99999;t3:%s\\007' '${start}'; ( eval ${quote(command)} ) </dev/null; __t3_code=$?; printf '\\033]99999;t3:%s:%s\\007' '${done}' "$__t3_code"; exit "$__t3_code"`,
    fish: `printf '\\033]99999;t3:%s\\007' '${start}'; (status fish-path) -c ${quote(command)} </dev/null; set -l t3_code $status; printf '\\033]99999;t3:%s:%s\\007' '${done}' $t3_code; exit $t3_code`,
    powershell: `$ErrorActionPreference = 'Stop'; [Console]::Write([char]27 + ']99999;t3:${start}' + [char]7); $t3_info = [System.Diagnostics.ProcessStartInfo]::new(); $t3_info.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName; $t3_info.UseShellExecute = $false; $t3_info.RedirectStandardInput = $true; $t3_info.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ${psEncoded}'; $t3_process = [System.Diagnostics.Process]::Start($t3_info); try { $t3_process.StandardInput.Close(); $t3_process.WaitForExit(); $t3_code = $t3_process.ExitCode } finally { $t3_process.Dispose() }; [Console]::Write([char]27 + ']99999;t3:${done}:' + $t3_code + [char]7); exit $t3_code`,
  };
}

/** Streaming ANSI removal also handles sequences split across terminal chunks. */
function outputCollector(token: string) {
  let pending = "";
  let started = false;
  let output = "";
  let truncated = false;
  let ansi = "text";
  let previousCR = false;
  const append = (data: string) => {
    for (const char of data) {
      // Control strings retain only their state, even without a terminator.
      if (char === "\x18" || char === "\x1a" || char === "\x9c") {
        ansi = "text";
        continue;
      }
      if (ansi === "osc" || ansi === "oscEsc" || ansi === "string" || ansi === "stringEsc") {
        const osc = ansi === "osc" || ansi === "oscEsc";
        const escaped = ansi === "oscEsc" || ansi === "stringEsc";
        if ((osc && char === "\x07") || (escaped && char === "\\")) ansi = "text";
        else if (char === "\x1b") ansi = osc ? "oscEsc" : "stringEsc";
        else ansi = osc ? "osc" : "string";
        continue;
      }
      if (char === "\x1b") {
        ansi = "esc";
        continue;
      }
      if (char === "\x9b" || char === "\x9d") {
        ansi = char === "\x9b" ? "csi" : "osc";
        continue;
      }
      if (char === "\x90" || char === "\x98" || char === "\x9e" || char === "\x9f") {
        ansi = "string";
        continue;
      }
      if (ansi === "esc") {
        ansi =
          char === "["
            ? "csi"
            : char === "]"
              ? "osc"
              : char === "P" || char === "X" || char === "^" || char === "_"
                ? "string"
                : char >= " " && char <= "/"
                  ? "escIntermediate"
                  : "text";
        continue;
      }
      if (ansi === "escIntermediate") {
        if (char >= "0" && char <= "~") ansi = "text";
        continue;
      }
      if (ansi === "csi") {
        if (char >= "@" && char <= "~") ansi = "text";
        continue;
      }
      if (char === "\n" && previousCR) {
        previousCR = false;
        continue;
      }
      previousCR = char === "\r";
      const clean = char === "\r" ? "\n" : char;
      if (clean !== "\n" && clean !== "\t" && (clean < " " || (clean >= "\x7f" && clean <= "\x9f")))
        continue;
      if (output.length < OUTPUT_LIMIT) output += clean;
      else truncated = true;
    }
  };
  const start = `\x1b]99999;t3:${token}:start\x07`;
  const done = `\x1b]99999;t3:${token}:done:`;
  return {
    feed(data: string): number | undefined {
      // Each pass consumes its input. Pending is bounded to one possible marker.
      for (let offset = 0; offset < data.length; offset += 4096) {
        pending += data.slice(offset, offset + 4096);
        if (!started) {
          const index = pending.indexOf(start);
          if (index < 0) {
            pending = pending.slice(-start.length);
            continue;
          }
          pending = pending.slice(index + start.length);
          started = true;
        }
        const index = pending.indexOf(done);
        if (index >= 0) {
          append(pending.slice(0, index));
          pending = pending.slice(index);
          const end = pending.indexOf("\x07", done.length);
          const code = end < 0 ? "" : pending.slice(done.length, end);
          if (/^-?\d+$/.test(code)) {
            pending = "";
            return Number(code);
          }
          // A malformed marker cannot retain unbounded output.
          if (pending.length > done.length + 24) {
            append(pending[0]!);
            pending = pending.slice(1);
          }
        } else {
          const safe = Math.max(0, pending.length - done.length);
          append(pending.slice(0, safe));
          pending = pending.slice(safe);
        }
      }
      return undefined;
    },
    finish() {
      if (started) append(pending);
      pending = "";
      const captured = { output, truncated };
      output = "";
      return captured;
    },
  };
}

const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager.TerminalManager;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const serviceScope = yield* Effect.scope;
  type Record = {
    readonly input: TerminalRunAndSendInput;
    readonly ready: Deferred.Deferred<void, TerminalRunAndSendError>;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    text?: string;
    delivered: boolean;
    delivering: boolean;
  };
  const runs = new Map<string, Record>();
  const gate = yield* Semaphore.make(1);
  const error = (input: TerminalRunAndSendInput, operation: string, cause: unknown) =>
    new TerminalRunAndSendError({
      threadId: input.threadId,
      terminalId: input.terminalId,
      operation,
      cause,
    });
  const deliver = (record: Record) =>
    Effect.gen(function* () {
      if (record.text === undefined || record.delivered || record.delivering) return;
      record.delivering = true;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: record.commandId,
          messageId: record.messageId,
          threadId: ThreadId.make(record.input.threadId),
          text: record.text,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) => error(record.input, "dispatchMessage", cause)),
          Effect.tap(() =>
            Effect.sync(() => {
              record.delivered = true;
              delete record.text;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              record.delivering = false;
            }),
          ),
        );
    });

  const run: TerminalRunAndSend["Service"]["run"] = Effect.fn("TerminalRunAndSend.run")(
    function* (input) {
      const key = `${input.threadId.length}:${input.threadId}${input.terminalId}`;
      const previous = runs.get(key);
      if (previous) {
        if (
          previous.input.command !== input.command ||
          previous.input.cwd !== input.cwd ||
          (previous.input.worktreePath ?? null) !== (input.worktreePath ?? null)
        ) {
          return yield* error(
            input,
            "terminalCollision",
            "Terminal identity belongs to another command",
          );
        }
        yield* Deferred.await(previous.ready);
        yield* deliver(previous);
        return {
          threadId: input.threadId,
          terminalId: input.terminalId,
          status: "already_started",
        };
      }
      if (runs.size >= RUN_LIMIT)
        return yield* error(input, "capacity", "Command registry is full");
      // Reserve before any asynchronous lookup or spawn. Retain identities for
      // this server lifetime, including failures and completed delivery retries.
      const record: Record = {
        input,
        ready: yield* Deferred.make<void, TerminalRunAndSendError>(),
        commandId: CommandId.make(`terminal:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`),
        messageId: MessageId.make(`terminal:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`),
        delivered: false,
        delivering: false,
      };
      runs.set(key, record);
      const launch = Effect.gen(function* () {
        const shell = yield* threads
          .getThreadShell(ThreadId.make(input.threadId))
          .pipe(Effect.mapError((cause) => error(input, "resolveThread", cause)));
        if (!shell || shell.archivedAt !== null || shell.deletedAt !== null)
          return yield* error(input, "resolveThread", "Thread is unavailable");
        const project = yield* projects
          .getById(shell.projectId)
          .pipe(Effect.mapError((cause) => error(input, "resolveProject", cause)));
        if (Option.isNone(project))
          return yield* error(input, "resolveProject", "Project is unavailable");
        const cwd = shell.worktreePath ?? project.value.workspaceRoot;
        if (
          !path.isAbsolute(input.cwd) ||
          path.resolve(input.cwd) !== path.resolve(cwd) ||
          (input.worktreePath ?? null) !== shell.worktreePath
        ) {
          return yield* error(
            input,
            "validateWorkspace",
            "Workspace does not match destination thread",
          );
        }
        const token = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
        const collector = outputCollector(token);
        const done = yield* Deferred.make<Completion>();
        let settled = false;
        const settle = (completion: Completion) =>
          Effect.suspend(() => {
            if (settled) return Effect.void;
            settled = true;
            return Deferred.succeed(done, completion).pipe(Effect.asVoid);
          });
        const unsubscribe = yield* terminals.subscribe((event) => {
          if (settled || event.threadId !== input.threadId || event.terminalId !== input.terminalId)
            return Effect.void;
          if (event.type === "output") {
            const exitCode = collector.feed(event.data);
            return exitCode === undefined
              ? Effect.void
              : settle({ exitCode, status: exitCode === 130 ? "cancelled" : "completed" });
          }
          if (event.type === "closed") return settle({ exitCode: null, status: "closed" });
          if (event.type === "exited")
            return settle({ exitCode: event.exitCode, status: "exited_without_completion" });
          if (event.type === "error") return settle({ exitCode: null, status: "error" });
          return Effect.void;
        });
        const opened = yield* terminals
          .openForCommand(
            {
              threadId: input.threadId,
              terminalId: input.terminalId,
              cwd,
              worktreePath: shell.worktreePath,
              env: { NO_COLOR: "1", FORCE_COLOR: "0" },
            },
            commandScripts(input.command, token),
          )
          .pipe(
            Effect.mapError((cause) => error(input, "openTerminal", cause)),
            Effect.onError(() => Effect.sync(unsubscribe)),
          );
        if (opened.status === "error") {
          unsubscribe();
          return yield* error(input, "openTerminal", "Command terminal failed to start");
        }
        let finished = false;
        yield* Scope.addFinalizer(
          serviceScope,
          Effect.suspend(() => {
            unsubscribe();
            return finished
              ? Effect.void
              : terminals
                  .close({ threadId: input.threadId, terminalId: input.terminalId })
                  .pipe(Effect.ignore);
          }),
        );
        yield* Effect.gen(function* () {
          const completion = yield* Deferred.await(done).pipe(
            Effect.timeoutOption("24 hours"),
            Effect.map(
              Option.getOrElse((): Completion => ({ exitCode: null, status: "timed_out" })),
            ),
          );
          unsubscribe();
          if (completion.status === "timed_out")
            yield* terminals
              .close({ threadId: input.threadId, terminalId: input.terminalId })
              .pipe(Effect.ignore);
          finished = true;
          const captured = collector.finish();
          record.text = `Terminal command: ${input.command}\nWorking directory: ${cwd}\nStatus: ${completion.status}\nExit code: ${completion.exitCode ?? "unknown"}\nOutput${captured.truncated ? " (truncated at 131072 characters)" : ""}:\n${captured.output}`;
          yield* deliver(record).pipe(
            Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 4 }),
          );
        }).pipe(
          Effect.ensuring(Effect.sync(unsubscribe)),
          Effect.catch((cause) =>
            terminals
              .reportDeliveryError({ threadId: input.threadId, terminalId: input.terminalId })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.logWarning("terminal.run-and-send.delivery-failed", {
                    threadId: input.threadId,
                    terminalId: input.terminalId,
                    operation: cause.operation,
                  }),
                ),
              ),
          ),
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
      });
      // Ownership transfers to the service before the RPC may be interrupted.
      yield* launch.pipe(
        Effect.tap(() => Deferred.succeed(record.ready, undefined)),
        Effect.tapError((cause) => Deferred.fail(record.ready, cause)),
        Effect.uninterruptible,
      );
      return { threadId: input.threadId, terminalId: input.terminalId, status: "started" };
    },
  );
  yield* Scope.addFinalizer(
    serviceScope,
    Effect.sync(() => runs.clear()),
  );
  return TerminalRunAndSend.of({ run: (input) => gate.withPermits(1)(run(input)) });
});

export const layer = Layer.effect(TerminalRunAndSend, make);
