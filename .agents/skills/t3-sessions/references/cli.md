# T3 CLI across environments

These examples use SSH to run the CLI on the destination. For a local
environment, run the same CLI commands directly. Replace `T3_HOST` with an
existing SSH destination for the account owning T3, and replace the executable,
T3 home, project path and IDs with checked destination values. Shell-quote
replacement arguments for the destination shell; the examples use POSIX shells.

Use the installed launcher for that environment. Desktop installations provide
`~/.t3/bin/t3`; another `t3` on a noninteractive PATH may belong to a different
installation. Keep `--base-dir` consistent on every command. It names the T3
home, not its `userdata` subdirectory or the project directory.

## Discover and inspect

Check the destination's installed capabilities before choosing commands or flags:

```sh
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread --help'
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread start --help'
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread list --base-dir "/absolute/path/to/t3-home" --json --project "/absolute/path/to/project"'
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread show --base-dir "/absolute/path/to/t3-home" --json --messages 4 "THREAD_ID"'
```

The project must already be registered on that environment. A project ID or a
path inside the project works. Use the exact thread ID from the destination,
including any `mcp:` prefix. `show --json` includes thread state and recent
messages; inspect its workspace, model and modes as relevant to the task.

## Send and retrieve the reply

Pass literal message text through stdin. A quoted heredoc keeps shell syntax in
the prompt from being evaluated by the sending shell:

```sh
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread send --base-dir "/absolute/path/to/t3-home" --json "THREAD_ID" -' <<'T3_MESSAGE'
Request REQUEST_ID from SOURCE_SESSION: please report the current result of TASK.
Reply in this conversation.
T3_MESSAGE
```

Replace the example message with the authorized request and a recognizable
correlation label. Retain the returned thread/run IDs. CLI `send` queues a new
turn behind a busy one; it does not steer or interrupt it.

Read the result from the same destination:

```sh
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread show --base-dir "/absolute/path/to/t3-home" --json --messages 4 "THREAD_ID"'
```

Match message `runId` values to the request, rather than assuming the latest
assistant message answers it. Increase `--messages` if another turn has since
run. For efficient paged history or richer run inspection, use destination MCP
tools when available; `--messages` limits printed output, not history retrieval.

When sending or starting, add `--wait` if you want that command to wait for its
run and print the reply. Use an interruptible execution session for long waits.
For a returned run result, exit 1 means it failed or stopped; exit 2 means it
needs an answer in the app. Command, transport and result-retrieval errors also
fail the command, so exit 1 alone does not prove the run failed. Inspect stderr
and any JSON status, IDs, reply and error; reconcile an unknown outcome before
retrying. IDs are printed after the wait finishes, so a disconnected wait can
leave no receipt. Without `--wait`, acceptance returns promptly and results can
be read later; it does not create an automatic completion callback.

## Start a requested conversation

Choose a destination project and give it a recognizable title and task label.
For independent code work, let T3 create and bind a worktree before the agent
starts:

```sh
ssh -o BatchMode=yes T3_HOST '"/absolute/path/to/t3" thread start --base-dir "/absolute/path/to/t3-home" --json --title "Requested task REQUEST_ID" --worktree "BASE_REF" --branch "NEW_BRANCH" --provider "PROVIDER_INSTANCE" --model "MODEL_SLUG" "/absolute/path/to/project" -' <<'T3_TASK'
Request REQUEST_ID from SOURCE_SESSION.
Task: DESCRIBE_REQUESTED_WORK
Scope and allowed actions: DESCRIBE_BOUNDARIES
Acceptance and reply: DESCRIBE_EXPECTED_RESULT
T3_TASK
```

Replace the example brief and every symbolic argument with the actual request
and checked destination values. `--provider` and `--model` go together and
replace the entire model selection; they do not inherit saved model options.
To retain project options, verify the complete destination default selection
and omit both flags. If the requested selection cannot be expressed by the CLI,
use an authorized destination MCP interface or report the gap before launch.
Omit `--worktree` and `--branch` when sharing the project folder is intended.
`--branch` requires `--worktree`, and the base ref and committed inputs must
exist remotely.

Read the new thread with `show --json` to confirm its workspace, model and modes
and obtain its link. It does not expose model options such as reasoning effort;
verify required options through supported project/configuration controls before
launch. The CLI's `start --json` result contains IDs, not a link.
Current CLI help does not expose model-option or permission-mode flags, or a
stop command. Check installed help for changes; do not invent flags or silently
drop requested settings. Use verified suitable defaults or an authorized
destination MCP interface when those controls are needed.

If SSH disconnects or a response is lost, reconcile `list` and `show` using
the title, request label and messages before repeating a mutation. Neither
`start` nor `send` exposes an idempotency flag. A reverse message needs its own
authorized destination connection; otherwise read the reply where it was sent.
