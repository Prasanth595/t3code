# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. T3 Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3 Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

T3 Code can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through T3 Code leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

## Compare runs with and without a skill

Codex 0.165.0 or newer supports session-scoped skill overrides. An agent can pass
`target.skillOverrides` to `delegate_task`. API callers can use the same field in
`modelSelection` when creating a fresh thread. Check
`orchestrator_capabilities.providers[].supportsSessionSkillOverrides` first.

For example, disable a discovered skill in one child:

```json
{
  "task": "Review the patch.",
  "target": {
    "providerInstanceId": "codex",
    "model": "your-model-id",
    "skillOverrides": [{ "path": "/workspace/skills/review/SKILL.md", "enabled": false }]
  }
}
```

Start a separate child with `enabled: true` for the comparison. Keep the task,
model, model options, tools, workspace snapshot, and provider version identical.
Use an absolute `SKILL.md` path from the destination environment's provider skill
catalog. Unknown paths and conflicting overrides for aliases are rejected.
Symlink aliases and discovered hardlinks resolve to the same file and receive the
same override.

Omitting `skillOverrides` preserves normal behavior, or inherits the parent's
overrides for a T3-managed child. An explicit empty array keeps provider skill
defaults. Every explicitly configured session disables native Codex subagents,
including the enabled comparison arm. T3-managed children inherit the policy and
cannot replace it. Other providers reject overrides rather than silently ignoring
them. A skill disabled by user or managed configuration cannot be enabled here.

Use `task_status.skillConfiguration` to inspect the provider version, requested
overrides, and resolved skill inventory after the child starts. For a remote child,
use `t3_thread_read` with its `environmentId` and `threadId`, then inspect
`thread.skillConfiguration`. Entries marked
`enabled: false` are excluded from Codex skill discovery and explicit skill-input
expansion. This inventory records the configuration T3 applied; Codex does not
provide a separate per-thread effective-skills readback. Its global `skills/list`
is not evidence of a particular thread's effective configuration.

Overrides are fixed for a native session, including after resume. Create a new
thread to change them or return to provider defaults. Native history forks are
rejected for configured sessions: previously loaded skill instructions cannot be
removed from conversation history. Keep skill files and configuration unchanged
throughout a comparison. Paths are environment-local, including for remote
children. Remote delegation checks the destination's advertised support before
launching; older servers that do not advertise it are rejected.

This controls Codex's skill machinery, not filesystem access. Tools can still
read skill files, follow copies, or launch another provider process. Instructions
copied into the task, project instructions, attachments, or earlier context are
not removed. Do not treat this as an adversarial sandbox or a guarantee that a
baseline has never encountered the skill's content.

### Usage attribution

Persisted provider turns include `turnTokenUsage`, with `usageStatus` set to
`complete`, `partial`, or `unavailable`. Codex attributes cumulative-token deltas
to native turn IDs. Claude uses result usage and combines steering segments.
These counts describe the main agent, not a guaranteed total for all native or
T3-managed children. Inspect `usageScope` and `hasSubagents`; do not treat missing
usage as zero or add reasoning tokens to output tokens again.

Runs retain requested, started, work-started, and completed timestamps. They can
measure wall-clock lifecycle time, which includes waits and orchestration, not
just model execution. Retries, resumed turns, and delegated children require
aggregation by run and attempt. `task_status` does not expose a complete token or
elapsed-time evaluation record. The Usage page aggregates provider history and
is not a substitute for per-run attribution.
