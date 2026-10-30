import {
  linkOriginIsFenced,
  ProjectId,
  ThreadId,
  type ProjectScript,
  type ProjectRunScriptInput,
  type ProjectRunScriptResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  projectScriptRuntimeEnv,
  projectScriptCwd,
  projectScriptReservesPort,
  projectScriptTerminalInput,
  resolveProjectScripts,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly scriptCommand: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly async: boolean;
  readonly threadId?: string;
  readonly port?: number;
  readonly commandDelivery?: Effect.Effect<void, ProjectSetupScriptOperationError>;
  /**
   * The exit code is null when the terminal exited or was closed before the sentinel arrived.
   */
  readonly completion?: Effect.Effect<ProjectSetupScriptCompletion>;
}

export interface ProjectSetupScriptCompletion {
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface ProjectSetupScriptOutputLine {
  readonly line: string;
}

/**
 * A thread a link below full access started does not run this project's setup
 * script: the script is the user's own code, and such a link only grants T3's
 * tools (see `mcp/linkOrigin.ts`).
 */
export interface ProjectSetupScriptRunnerResultSkippedForLink {
  readonly status: "skipped-for-link";
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultSkippedForLink
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string | null;
  readonly trigger?: "setup" | "settle";
  readonly scriptId?: string;
  readonly project?: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript>;
  };
  readonly observeCompletion?: {
    readonly onOutputLine?: (line: string) => Effect.Effect<void>;
  };
}

export class ProjectSetupScriptOperationError extends Schema.TaggedError<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
    operation: Schema.Literals([
      "readThread",
      "resolveProject",
      "readSettings",
      "reservePort",
      "openTerminal",
      "writeCommand",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedError<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
    readonly runScript: (
      input: ProjectRunScriptInput,
    ) => Effect.Effect<ProjectRunScriptResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

/** @public */
// Random per-run tokens prevent script output from spoofing completion.
const COMPLETION_SENTINEL_PREFIX = "__T3_SETUP_DONE__";
const OUTPUT_LINE_MAX_LENGTH = 400;
const PARTIAL_LINE_MAX_LENGTH = 4_096;

function completionSentinel(token: string): string {
  return `${COMPLETION_SENTINEL_PREFIX}_${token}:`;
}

function completionSentinelPattern(token: string): RegExp {
  return new RegExp(`${COMPLETION_SENTINEL_PREFIX}_${token}:(-?\\d+)`);
}

function stripTerminalControl(text: string): string {
  return text
    .replace(
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// Line editors (zsh, fish, bash 5.1+) enable bracketed paste when they start reading a command.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
// Longer than one subprocess poll plus its ps timeout, so a startup prompt is seen as busy first.
const SHELL_QUIET_FALLBACK = "3 seconds";

function lineEditorReading(text: string, previous: boolean): boolean {
  for (const match of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    if (match[1]?.split(";").includes("2004")) previous = match[2] === "h";
  }
  return previous;
}

type CompletionShell = "posix" | "fish" | "powershell";

function resolveCompletionShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): CompletionShell {
  if (platform === "win32") return "powershell";
  const shell = env.SHELL ?? "";
  const name = shell.split("/").at(-1) ?? shell;
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return "posix";
}

// A block protects the sentinel from comments, heredocs and stdin reads; shell hooks survive Ctrl+C.
function wrapCommandForCompletion(
  command: string,
  shell: CompletionShell,
  sentinel: string,
): string {
  const body = command.replace(/\r?\n/g, "\r");
  switch (shell) {
    case "powershell":
      return `$global:LASTEXITCODE = $null; $__t3c = 130; try { & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 } } finally { Write-Host "${sentinel}$__t3c" }`;
    case "fish": {
      const completionFunction = sentinel.slice(0, -1);
      return `begin\rfunction ${completionFunction} --on-event fish_postexec\rprintf '\\n${sentinel}%s\\n' 130\rfunctions -e ${completionFunction}\rend\rbegin\r${body}\rend\rset -l __t3c $status\rfunctions -e ${completionFunction}\rprintf '\\n${sentinel}%s\\n' $__t3c\rend`;
    }
    case "posix":
      return `(\rtrap 'exit 130' INT\rtrap 'printf "\\n${sentinel}%s\\n" "$?"' EXIT\r( ${body}\r)\r)`;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scriptPorts = yield* ProjectScriptPorts.ProjectScriptPorts;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
  const launchLocks = yield* KeyedLock.make<number>();
  const activeRuns = new Map<number, ProjectSetupScriptRunnerResultStarted>();
  const completionShell = resolveCompletionShell(
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );

  const observeTerminalCompletion = Effect.fn("ProjectSetupScriptRunner.observeTerminalCompletion")(
    function* (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly sentinel: string;
      readonly sentinelPattern: RegExp;
      /** The shell echoes typed input, alone or after its prompt; those lines are the wrapper, not output. */
      readonly echoedWrapperLines: ReadonlyArray<string>;
      readonly onOutputLine: ((line: string) => Effect.Effect<void>) | undefined;
    }) {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const done = yield* Deferred.make<ProjectSetupScriptCompletion>();
      // Wait for the prompt redraw; closing earlier mistakes it for activity and preserves an idle shell.
      const promptReturned = yield* Deferred.make<void>();
      let lineBuffer = "";
      let settled = false;
      let trackReplacements = false;

      const settle = (exitCode: number | null) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          settled = true;
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              Deferred.succeed(done, { exitCode, durationMs: nowMs - startedAtMs }),
            ),
            Effect.asVoid,
          );
        });

      const handleLine = (rawLine: string) =>
        Effect.suspend(() => {
          const sentinel = input.sentinelPattern.exec(rawLine);
          if (sentinel) {
            const parsed = Number(sentinel[1]);
            return settle(Number.isFinite(parsed) ? parsed : null);
          }
          const cleaned = stripTerminalControl(rawLine).trimEnd();
          if (
            cleaned.length === 0 ||
            cleaned.includes(input.sentinel) ||
            input.echoedWrapperLines.some(
              (echoed) =>
                cleaned.trimStart() === echoed ||
                (cleaned.endsWith(` ${echoed}`) &&
                  /[$%#>] +$/.test(cleaned.slice(0, -echoed.length))),
            ) ||
            input.onOutputLine === undefined
          ) {
            return Effect.void;
          }
          return input.onOutputLine(cleaned.slice(0, OUTPUT_LINE_MAX_LENGTH));
        });

      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        if (event.type === "output") {
          lineBuffer += event.data;
          // Bare CR redraws progress in place; split redraws instead of growing one line.
          const lines = lineBuffer.split(/\r\n|\r|\n/);
          lineBuffer = lines.pop() ?? "";
          // Bound newline-free output; the sentinel has its own line, so retaining the tail is safe.
          if (lineBuffer.length > PARTIAL_LINE_MAX_LENGTH) {
            lineBuffer = lineBuffer.slice(-PARTIAL_LINE_MAX_LENGTH);
          }
          return Effect.forEach(lines, handleLine, { discard: true }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                settled && lineBuffer.length > 0
                  ? Deferred.succeed(promptReturned, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
          );
        }
        if (
          event.type === "exited" ||
          event.type === "closed" ||
          event.type === "error" ||
          (trackReplacements && (event.type === "started" || event.type === "restarted"))
        ) {
          return settle(null).pipe(Effect.andThen(Deferred.succeed(promptReturned, undefined)));
        }
        return Effect.void;
      });

      const completion = Deferred.await(done).pipe(
        // A shell with an empty prompt never prints one; do not wait forever.
        Effect.tap(() => Deferred.await(promptReturned).pipe(Effect.timeoutOption("1 second"))),
        Effect.ensuring(Effect.sync(() => unsubscribe())),
      );
      // A startup prompt waits for input on a line that has no newline yet.
      const flushPartialLine = Effect.suspend(() => {
        const partial = lineBuffer;
        lineBuffer = "";
        return handleLine(partial);
      });
      const abandon = settle(null).pipe(
        Effect.andThen(Deferred.succeed(promptReturned, undefined)),
      );
      return {
        completion,
        unsubscribe,
        flushPartialLine,
        abandon,
        trackReplacements: () => {
          trackReplacements = true;
        },
      };
    },
  );

  // Input typed during shell startup can be read by an rc-file prompt (fnm, nvm) instead of the
  // shell, which loses the command. Subscribe before the terminal opens so no activity is missed.
  const watchShellReadiness = Effect.fn("ProjectSetupScriptRunner.watchShellReadiness")(
    function* (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly onStartupPrompt: Effect.Effect<void>;
    }) {
      const outcome = yield* Deferred.make<"ready" | "exited">();
      let reading = false;
      let carry = "";
      let busy = false;
      let activity = 0;
      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        activity += 1;
        // A new shell process starts idle; the manager resets its subprocess state without an event.
        if (event.type === "started" || event.type === "restarted") {
          busy = false;
          reading = false;
          carry = "";
        }
        if (event.type === "activity") busy = event.hasRunningSubprocess;
        if (event.type === "output") {
          const text = carry + event.data;
          carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
          reading = lineEditorReading(text, reading);
        }
        if (event.type === "exited" || event.type === "closed") {
          return Deferred.succeed(outcome, "exited").pipe(Effect.asVoid);
        }
        return reading ? Deferred.succeed(outcome, "ready").pipe(Effect.asVoid) : Effect.void;
      });
      // A startup prompt runs as a child process, so a busy shell keeps waiting for the user.
      const quiet = Effect.gen(function* () {
        while (true) {
          const seen = activity;
          yield* Effect.sleep(SHELL_QUIET_FALLBACK);
          if (activity !== seen) continue;
          if (!busy) return "ready" as const;
          yield* input.onStartupPrompt;
        }
      });
      const wait = Deferred.await(outcome).pipe(Effect.raceFirst(quiet));
      return {
        wait,
        unsubscribe,
        markReady: Deferred.succeed(outcome, "ready").pipe(Effect.asVoid),
      };
    },
  );

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const operationError =
      (operation: ProjectSetupScriptOperationError["operation"]) => (cause: unknown) =>
        new ProjectSetupScriptOperationError({ ...errorContext, operation, cause });
    // A thread whose origin cannot be read might be a link's: run nothing.
    const thread = yield* threads
      .getThreadShell(ThreadId.make(input.threadId))
      .pipe(Effect.mapError(operationError("readThread")));
    if (thread?.linkOrigin !== undefined && linkOriginIsFenced(thread.linkOrigin))
      return { status: "skipped-for-link" } as const;
    const project =
      input.project ??
      (input.projectId
        ? yield* projects
            .getById(ProjectId.make(input.projectId))
            .pipe(
              Effect.map(Option.getOrUndefined),
              Effect.mapError(operationError("resolveProject")),
            )
        : null) ??
      (input.projectCwd
        ? yield* projects
            .getByWorkspaceRoot(input.projectCwd)
            .pipe(
              Effect.map(Option.getOrUndefined),
              Effect.mapError(operationError("resolveProject")),
            )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(operationError("readSettings")),
    );
    const trigger = input.trigger ?? "setup";
    const scripts = resolveProjectScripts(settings, project);
    const script = input.scriptId
      ? scripts.find((candidate) => candidate.id === input.scriptId)
      : trigger === "settle"
        ? settleProjectScript(scripts)
        : setupProjectScript(scripts);
    if (!script || (input.scriptId !== undefined && !projectScriptReservesPort(script))) {
      return {
        status: "no-script",
      } as const;
    }

    const cwd = projectScriptCwd({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const port = projectScriptReservesPort(script)
      ? yield* scriptPorts
          .reserve({ cwd, scriptId: script.id })
          .pipe(Effect.mapError(operationError("reservePort")))
      : undefined;
    const launch = Effect.gen(function* () {
      const active = port === undefined ? undefined : activeRuns.get(port);
      if (active) {
        return input.scriptId !== undefined || active.threadId === input.threadId
          ? active
          : ({ status: "no-script" } as const);
      }

      // A resumed thread can settle again while its earlier settle shell is still busy.
      // Give each settle run a new terminal rather than typing into the foreground program.
      const terminalId =
        port !== undefined
          ? `script-${port}`
          : trigger === "settle"
            ? `settle-${script.id}-${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8)}`
            : `setup-${script.id}`;
      const result = {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        scriptCommand: script.command,
        terminalId,
        cwd,
        async: script.async !== false,
      } as const;
      const env = {
        ...projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: input.worktreePath,
          ...(port === undefined ? {} : { extraEnv: { T3CODE_PREVIEW_PORT: String(port) } }),
        }),
        // Setup can run before a client attaches. Truecolor probes in tools such
        // as Vite+ wait for terminal replies that nobody can send at that point.
        ...(input.scriptId === undefined ? { COLORTERM: "", NO_COLOR: "1", FORCE_COLOR: "0" } : {}),
      };
      const observe = input.observeCompletion ?? (port === undefined ? undefined : {});
      const completionToken = observe
        ? (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "")
        : null;
      const commandLine =
        observe && completionToken
          ? wrapCommandForCompletion(
              script.command,
              completionShell,
              completionSentinel(completionToken),
            )
          : script.command;

      const observed =
        observe && completionToken
          ? yield* observeTerminalCompletion({
              threadId: input.threadId,
              terminalId,
              sentinel: completionSentinel(completionToken),
              sentinelPattern: completionSentinelPattern(completionToken),
              echoedWrapperLines: commandLine.split("\r").filter((line) => line.length > 0),
              onOutputLine: observe.onOutputLine,
            })
          : undefined;
      // PowerShell has no line-editor signal; keep its immediate write.
      const readiness =
        completionShell === "powershell"
          ? undefined
          : yield* watchShellReadiness({
              threadId: input.threadId,
              terminalId,
              onStartupPrompt: observed?.flushPartialLine ?? Effect.void,
            });
      const unsubscribe = () => {
        observed?.unsubscribe();
        readiness?.unsubscribe();
      };
      const opened = yield* terminalManager
        .open({ threadId: input.threadId, terminalId, cwd, worktreePath: input.worktreePath, env })
        .pipe(
          Effect.mapError(operationError("openTerminal")),
          Effect.onError(() => Effect.sync(unsubscribe)),
        );
      const expectedPid = opened.pid;
      if (expectedPid === null || opened.status !== "running") {
        unsubscribe();
        return yield* new ProjectSetupScriptOperationError({
          ...errorContext,
          operation: "openTerminal",
          cause: new TerminalManager.TerminalNotRunningError({
            threadId: input.threadId,
            terminalId,
          }),
        });
      }
      if (port !== undefined) observed?.trackReplacements();
      // Restored history ends with a mode reset; a live idle shell keeps its line editor enabled.
      if (readiness && lineEditorReading(opened.history, false)) yield* readiness.markReady;

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const delivered = yield* Deferred.make<void, ProjectSetupScriptOperationError>();
          const completion = observed?.completion.pipe(
            Effect.tap(({ exitCode }) =>
              exitCode === 0 && input.observeCompletion !== undefined
                ? terminalManager.closeIdle({ threadId: input.threadId, terminalId })
                : Effect.void,
            ),
          );
          const done =
            port !== undefined && completion
              ? yield* Deferred.make<ProjectSetupScriptCompletion>()
              : undefined;
          const started = {
            ...result,
            ...(port === undefined
              ? {}
              : {
                  threadId: input.threadId,
                  port,
                  commandDelivery: Deferred.await(delivered),
                }),
            ...(done ? { completion: Deferred.await(done) } : completion ? { completion } : {}),
          };
          // Pending startup owns the port too, so a second caller cannot queue another command.
          if (port !== undefined) activeRuns.set(port, started);
          const release = () => {
            if (port !== undefined && activeRuns.get(port) === started) activeRuns.delete(port);
          };
          yield* Effect.gen(function* () {
            yield* Deferred.complete(
              delivered,
              (readiness?.wait ?? Effect.succeed("ready" as const)).pipe(
                Effect.flatMap((shell) =>
                  shell === "exited"
                    ? Effect.fail(
                        new TerminalManager.TerminalNotRunningError({
                          threadId: input.threadId,
                          terminalId,
                        }),
                      )
                    : terminalManager
                        .write({
                          threadId: input.threadId,
                          terminalId,
                          ...(port === undefined ? {} : { expectedPid }),
                          data: projectScriptTerminalInput(commandLine),
                        })
                        .pipe(Effect.uninterruptible),
                ),
                Effect.mapError(operationError("writeCommand")),
                Effect.onError(() =>
                  Effect.sync(() => {
                    unsubscribe();
                    release();
                  }),
                ),
                Effect.ensuring(Effect.sync(() => readiness?.unsubscribe())),
              ),
            );
            yield* Deferred.await(delivered).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("project script command was not written", {
                  ...errorContext,
                  terminalId,
                  cause,
                }).pipe(Effect.andThen(observed?.abandon ?? Effect.void)),
              ),
            );
            if (done && completion)
              yield* Deferred.complete(
                done,
                completion.pipe(Effect.ensuring(Effect.sync(release))),
              );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                readiness?.unsubscribe();
                if (port !== undefined) {
                  observed?.unsubscribe();
                  release();
                }
              }),
            ),
            Effect.interruptible,
            Effect.forkIn(serviceScope, { startImmediately: true }),
          );
          return started;
        }),
      );
    });
    return yield* port === undefined ? launch : launchLocks.withLock(port, launch);
  });

  const runScript: ProjectSetupScriptRunner["Service"]["runScript"] = Effect.fn(
    "ProjectSetupScriptRunner.runScript",
  )(function* (input) {
    const result = yield* runForThread(input);
    if (result.status === "started" && result.commandDelivery) yield* result.commandDelivery;
    return result.status === "started" && result.port !== undefined
      ? {
          status: "started" as const,
          threadId: ThreadId.make(result.threadId ?? input.threadId),
          terminalId: result.terminalId,
          port: result.port,
        }
      : { status: "no-script" as const };
  });

  return ProjectSetupScriptRunner.of({ runForThread, runScript });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
