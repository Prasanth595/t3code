---
name: t3-sessions
description: Find, read, message, and start T3 Code conversations, including sessions on another environment through an existing SSH connection. Use for T3 session communication, not ordinary coding or generic subagent requests.
---

# T3 sessions

T3 tools address the environment serving them. Seeing another environment in
the client does not make its threads reachable through the current MCP server;
a local `thread_not_found` does not establish that a remote thread is gone.

## Choose the destination

Identify the destination environment, project and exact thread ID. Keep any
`mcp:` prefix. Use an available, authorized MCP connection to that destination
and its current tool schemas. Do not invent an environment-routing parameter.

For another host without a destination MCP connection, use its supported
`t3 thread` CLI over an existing authorized SSH route, as the account owning
that T3 environment. Confirm the executable and T3 home, including any custom
`--base-dir`. Read [CLI and SSH commands](references/cli.md) before using this
route. The same CLI works locally for agents outside T3.

[Outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)
describes supported MCP setup. Missing access, authentication or a running
server is a prerequisite to report; do not extract credentials, hand-build
tokens, write the live database or restart a service to reach a thread.

## Read, message or start

- Inspect the destination thread's state and recent messages before answering
  about it or sending. Resolve ambiguous recipients before a mutation. Sending
  or launching must be authorized by the user's task; reading a reference does
  not authorize a message.
- Start a top-level conversation only when a new or separate session was
  requested. A subagent request uses the host's delegation workflow. CLI-created
  conversations have no delegated-task lifecycle or automatic parent result
  delivery.
- Select the destination project and intended workspace before launch. Use the
  supported worktree option for independent code work. Its base ref must exist
  on the destination; local dirty files and caller context do not transfer.
- CLI launches use destination defaults, not the caller's settings. Preserve
  requested provider, model, options and permission limits. If the destination
  interface cannot represent or verify them, report the gap before launch.
  Host access does not override the calling session's restrictions.

## Receive and continue

Retain the destination, thread/run IDs and observed status. Use the returned
thread link when available. Acceptance is not completion: inspect the result
for the requested run, including failed or waiting-for-input states.

After an uncertain send or launch, inspect the destination before retrying.
The CLI exposes no retry key. If you cannot establish whether it succeeded,
report the uncertainty instead of duplicating work.

Before following up, inspect the latest messages and respect a user's takeover
or stop request. Stopping automatic messages does not stop a running agent;
use an available, authorized stop control if that is what the user requested.
