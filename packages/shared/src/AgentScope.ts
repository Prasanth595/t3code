import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface AgentScopeShape {
  readonly wrap: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly name: string;
    readonly threadId?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /**
     * Terminals opt out of parent-death signals and leftover-agent cleanup so
     * detached jobs (tmux, nohup) can survive a server restart.
     */
    readonly survivesRestart?: boolean | undefined;
    /**
     * Keep a shared process running after a tool OOM when supported.
     * Falls back to ordinary scope behavior on older systemd.
     */
    readonly shared?: boolean | undefined;
  }) => Effect.Effect<AgentScopeCommand>;
  readonly oomKilled: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Forgets the thread's scope. The session manager calls it before it opens
   * a provider session, so a scope only answers for the session that launched
   * it, even when the next session runs without one (Cursor, OpenCode).
   */
  readonly clear: (threadId: string) => Effect.Effect<void>;
}

export interface AgentScopeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const AgentScope = Context.Reference<AgentScopeShape>("@t3tools/shared/AgentScope", {
  defaultValue: () => ({
    wrap: ({ command, args }) => Effect.succeed({ command, args }),
    oomKilled: () => Effect.succeed(false),
    clear: () => Effect.void,
  }),
});

export const AgentScopeThreadId = Context.Reference<string | undefined>(
  "@t3tools/shared/AgentScope/ThreadId",
  { defaultValue: () => undefined },
);

export const AGENT_OOM_SCORE_ADJ = 800;

export const RAISE_OOM_SCORE_LINE = `{ echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`;

const LAUNCH_LINES = [RAISE_OOM_SCORE_LINE, 'exec "$@"'];

// systemd-run needs XDG_RUNTIME_DIR to reach the user manager. Fill it in when
// the agent environment does not carry it; it is the same user either way.
const SCOPED_LAUNCH_LINES = [
  RAISE_OOM_SCORE_LINE,
  ': "${XDG_RUNTIME_DIR:=$1}"',
  "export XDG_RUNTIME_DIR",
  "shift",
  'exec "$@"',
];

// The parent-death signal only fires for a parent that exits after it is set.
// A server that died first has already orphaned the launch, so it stops here.
const SERVER_CHECK_LINES = ['[ "$PPID" = "$1" ] || exit 1', "shift"];

export interface AgentSystemdScope {
  readonly systemdRun: string;
  readonly slice: string;
  readonly unit: string;
  readonly runtimeDir: string;
  readonly options: ReadonlyArray<string>;
}

/**
 * Sends SIGTERM when the launching server dies, including on SIGKILL or a crash.
 * Only the agent receives it; descendant cleanup relies on its signal handler.
 */
export interface AgentServerLink {
  readonly setpriv: string;
  readonly serverPid: number;
}

/**
 * Every step `exec`s, so the spawned PID, stdio, and signals all belong to the agent itself.
 * `systemd-run --scope` registers its own PID as the scope and then runs the command, so the
 * agent and all of its children start inside the scope.
 */
export function agentScopeCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly scope?: AgentSystemdScope | undefined;
  readonly server?: AgentServerLink | undefined;
}): AgentScopeCommand {
  const { command, args, scope, server } = input;
  const [lines, launchArgs] =
    scope === undefined
      ? [LAUNCH_LINES, [command, ...args]]
      : [
          SCOPED_LAUNCH_LINES,
          [
            scope.runtimeDir,
            scope.systemdRun,
            "--user",
            "--scope",
            "--quiet",
            `--slice=${scope.slice}`,
            `--unit=${scope.unit}`,
            ...scope.options,
            "--",
            command,
            ...args,
          ],
        ];
  if (server === undefined) {
    return { command: "/bin/sh", args: ["-c", lines.join("\n"), "t3-agent", ...launchArgs] };
  }
  return {
    command: server.setpriv,
    args: [
      "--pdeathsig",
      "TERM",
      "--",
      "/bin/sh",
      "-c",
      [...SERVER_CHECK_LINES, ...lines].join("\n"),
      "t3-agent",
      String(server.serverPid),
      ...launchArgs,
    ],
  };
}
