# Managed ACP proxy

`subpolar-acp` keeps its existing local runtime as the default. Set
`SUBPOLAR_ACP_EXECUTION=managed` to proxy ACP sessions to a process started by
the authenticated Subpolar environment manager. The proxy keeps ACP on stdio,
starts a separate worker process for each `session/new` cwd, forwards session
requests and notifications through `effect-acp`, and forwards worker permission
requests to the T3 ACP client. The worker's ACP session ID is returned unchanged
to T3 and remains the ID used for subsequent calls and updates. Requests that
need a worker must carry that session ID; unscoped requests fail instead of
being sent to an arbitrary session's worktree.

Managed mode requires `SUBPOLAR_MANAGER_URL`, `SUBPOLAR_MANAGER_TOKEN`,
`SUBPOLAR_STORAGE_ROOT`, and `SUBPOLAR_ACP_WORKER_COMMAND`. The worker command
must be a JSON argv array, for example:

```sh
SUBPOLAR_ACP_EXECUTION=managed
SUBPOLAR_ACP_WORKER_COMMAND='["/opt/subpolar/bin/acp-worker"]'
```

The command is passed directly to the manager without a shell. It must name an
ACP server executable that is already installed in the worker image. Do not
point it at this gateway's ACP CLI unless that CLI and its dependencies are
also packaged in the worker image; the worker environment sets
`SUBPOLAR_ACP_EXECUTION=local` to prevent recursive manager proxying.

The current worker image recipe only packages process supervisors. It does not
install the Subpolar ACP package, Pi SDK, or Pi credentials. Operators must
package a compatible ACP worker and provide its runtime credentials and network
access within that environment before managed ACP can run a real Pi turn. This
proxy and its protocol tests do not establish that worker image or end-to-end
runtime configuration.

When the worker command starts the Subpolar ACP CLI, the managed proxy supplies
`SUBPOLAR_ACP_WORKER_MODE=1` and `SUBPOLAR_ACP_EXECUTION=local` in the worker's
filtered environment. Worker mode adds one `execute` tool that runs argv
directly inside the worker, requires T3's existing per-call ACP approval,
limits captured output to 128 KiB, and confines its working directory to the
mounted worktree. The tool does not call the environment manager and rejects
attempts to pass manager credentials to child commands. Ordinary local ACP
mode keeps its existing manager-backed tool behavior.

Worker mode only supplies local command execution. It does not package the ACP
CLI or Pi SDK, configure model credentials, or allow model API network access;
those remain prerequisites for a complete managed ACP deployment.
