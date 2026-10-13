# Fork tools for agents

This guide maps owner tasks to the fork tools. It is for agents that operate the T3 machines of the owner, the machine map, and the fork deploys and updates. [fork.md](fork.md) explains how each feature works. [apps/machine-map/SPEC.md](../apps/machine-map/SPEC.md) holds the machine map requirements (MM-xxx).

## Rules

- Never kill a process that you found by a name, a path or a pattern. Kill only a PID that you started.
- Never write to `~/.t3/userdata` on a machine. It is the live install. Read it or copy from it only.
- Stage files by path only. Never use `git add -A` or `git add .`. Worktrees hold links to private files from `_shared/`.
- Put every fork behaviour behind a setting that is off by default.
- Never deploy the portal or the VPS by hand. Merge to main. The automation deploys main.
- Never put secrets in the repository, a commit, a pull request or a comment. Secrets stay in `~/Github/t3code/_shared/`.

## Find the tools

- An agent in a T3 thread gets the fork MCP tools with the other T3 tools. Their descriptions hold the permissions, the side effects and the result shapes.
- In a terminal, run `t3 tool list` for all tools and `t3 tool describe <name>` for one tool. Run `t3 tool call <name> --input '<json>'` to call one. In a checkout, use `node apps/server/src/bin.ts` instead of `t3`.
- The fork MCP tools are `machines_read`, `machines_resources`, `machines_set_access`, `machines_set_setting`, `machines_command`, `machines_queue_cancel`, `machines_undo`, `machines_preset`, `machines_join` and `machine_tool_call`.

## Machine map

The portal is `https://t3.yarden-zamir.com`. Each machine is one T3 server, for example Mac, VPS and Windows. Call `machines_read` first: it gives the machine ids, the map roles, the arrows and the supported commands of each machine.

- The map role of the machine that runs the agent decides what the agent can do: `read` reads, `propose` sends changes to the owner Inbox, `edit` applies changes. `machines_command` and `machines_queue_cancel` need `edit`.
- A change that raises access of the agent's own machine always waits for the owner.
- While the owner's emergency pause is on, the portal refuses every agent call. Only the owner can resume, in the portal.
- The owner HTTP API (`apps/machine-map/src/worker.ts`, `/api/*`) needs the owner's Cloudflare Access login. Agents do not use it. Use the MCP tools.

| Task                                   | Do this                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See the machines and their state       | `machines_read`.                                                                                                                                                       |
| See the load and alerts of machines    | `machines_read`. `resources` holds the newest sample, the thresholds and the active alerts.                                                                            |
| See the resource history of a machine  | `machines_resources` with `machineId` and `range` (`hour`, `day` or `month`).                                                                                          |
| Give machine X access to machine Y     | `machines_set_access` with `from` X, `to` Y, a `level`, and `agentTools: true` if agents on X must call tools on Y. Add `expiresInMinutes` for temporary access.       |
| Remove access                          | `machines_set_access` with `level: "none"`. The sessions of X on Y end at once.                                                                                        |
| Run a tool on another machine          | `machine_tool_call` with `machine`, `tool` and `input`. It needs an arrow with agent tools from this machine to that machine.                                          |
| Start work on another machine          | `machine_tool_call` with `t3_thread_launch`, or `machines_command` with `{"_tag":"startThread",...}`.                                                                  |
| Change a setting on every machine      | `machines_set_setting` without `machineId`. Only settings that the owner manages on the map work.                                                                      |
| Change a setting on one machine        | `machines_set_setting` with `machineId`. Pass `clear: true` to follow the shared value again.                                                                          |
| Restart a server, collect diagnostics  | `machines_command` with `restartServer` or `collectDiagnostics`. Read the result later in `commands` of `machines_read`.                                               |
| Stop the agents on one machine         | `machines_command` with `stopAllAgents`.                                                                                                                               |
| Stop everything                        | Ask the owner to press the emergency pause in the portal. It stops all agents and sets all access to none. Agents cannot press it.                                     |
| Remove all machine access, keep agents | `machines_preset` with `action: "lockdown"`. Afterwards no agent can use the map tools.                                                                                |
| Revert a map change                    | `machines_undo` with the revision number from `history`. Commands cannot be undone.                                                                                    |
| Cancel a queued command                | `machines_queue_cancel` with the command id.                                                                                                                           |
| Join a new machine                     | Ask the owner for a join code from Add machine. Then call `machines_join`, or run `t3 machine-map join <code>` on that machine.                                        |
| Install the fork on a new machine      | Run the step 0 command of the join dialog there: `install.sh --join <code>` or `install.ps1 -Join <code>` from `scripts/fork-install`. See fork.md "Install the fork". |

## Updates and deploys

| Task                         | Do this                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship a fork change           | Open a pull request on `Yarden-zamir/t3code` and merge it to main after the checks pass. Main deploys itself.                                                                                                                |
| Update the Mac               | Merge to main. `scripts/fork-live/build.sh` builds main every minute. Then `machines_command` with `{"_tag":"installUpdate","whenIdle":true}` for the Mac, or ask the owner to press the update button. The app must run.    |
| Update the VPS               | Merge to main. `t3-deploy.timer` runs `scripts/fork-vps/deploy.sh`. It waits until main is quiet for 10 minutes and no agent turn runs. Read the result with `ssh yarden-zamir-vps-2 journalctl -u t3-deploy.service -n 50`. |
| Deploy the portal            | Merge a change in `apps/machine-map` or `packages/contracts/src/machineMap*.ts` to main. The workflow "Machine map deploy" tests and deploys it. A deploy from a branch rolls back main.                                     |
| Release a desktop app        | Merge an app shell change to main, or run the workflow "Fork Release". It builds the Mac, Windows and Linux apps and the Linux server archive.                                                                                                                   |
| Take upstream changes        | Run the workflow "Fork Sync", or wait for its daily run. A conflict comments on the issue "Fork sync: upstream merge failed".                                                                                                |
| Build and install on the Mac | Run `PATH="$PWD/node_modules/.bin:$PATH" ./scripts/fork-desktop-mac.sh --install` from `~/Github/t3code/main`. Use it only when the owner asks, because it replaces the running app.                                         |

## Repair agent

When Fork CI, Fork Sync or Fork Release fails, `scripts/fork-notify-agent.sh` posts the run to the webhook in the GitHub secret `T3_AGENT_WEBHOOK_URL`. The webhook is a scheduled task on a T3 server that starts a repair agent.

- The repair agent watches the next run of the same workflow.
- On a retry, run the workflow with `notify_agent=false`, so that a second failure does not start another agent.
- A failure right after a failure of the same workflow does not post.
