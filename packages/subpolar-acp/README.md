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
