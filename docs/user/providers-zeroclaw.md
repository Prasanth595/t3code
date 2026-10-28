# ZeroClaw

ZeroClaw is a local multi-agent daemon. T3 Code talks to it over its Unix socket
(or Windows named pipe) and can run several threads on one connection.

## Set up

1. Start the daemon: `zeroclaw daemon`.
2. In T3 Code, open **Settings → Providers** and enable **ZeroClaw**.
3. Set **Daemon socket** if the daemon is not on the default path. An empty path
   uses `ZEROCLAW_SOCKET`, then the daemon's default data directory.
4. Set **Default agent** to the alias a new thread should use when the thread
   does not pick one.

The provider ships disabled. Enabling it does not start the daemon; T3 Code only
connects to a socket that is already listening.

## Agents

An agent belongs to the thread, not to the turn. Pick it when the thread starts.
Changing the agent later fails with a message asking you to start a new thread,
because ZeroClaw cannot swap the agent of a live session.

## Models

The model list comes from the daemon's catalog. **Agent default** means whatever
model that agent is configured with, and T3 Code does not send it to the daemon.

Switching to a named model mid-thread applies immediately. Switching back to
**Agent default** after that does not: ZeroClaw cannot clear a model override in
a live session, so T3 Code fails the turn and asks you to start a new thread.

## Approvals

ZeroClaw decides which tools ask for approval from its own autonomy config.
T3 Code shows the provider as approval-required, but that is not a promise that
every tool prompts. A pending approval dies with the connection.

## Subagents

A foreground `spawn_subagent` or `delegate` call shows as a subagent card and
settles when the tool result arrives. A background delegate stays a plain tool
call, because T3 Code cannot see it finish.
