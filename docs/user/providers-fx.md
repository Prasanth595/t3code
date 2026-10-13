# fx

T3 Code can run [fx](https://fx.sh). fx uses the login on the machine that runs the T3 Code server.

## Set up fx

1. Install fx on that machine:

   ```bash
   curl -fsSL https://fx.sh/setup.sh | bash
   ```

2. Run `fx login` in a terminal on that machine.
3. Open **Settings → Providers**, enable fx, and refresh the provider.

If `fx` is not on the server's `PATH`, set **Binary path** to the executable.

Every fx instance on the same machine shares that machine's fx login. T3 Code does not keep a separate login per instance.

## Models and effort

The model picker lists **Default** first. That option runs the model fx is configured to use, as `fx status` reports it. The other entries come from `fx models`.

fx also has an **Effort** control. A new thread starts at Medium.

T3 Code does not show fx's backend selector. To use Codex, Grok, or Vercel AI Gateway, run `fx provider` on the environment's machine.

Type `$` in the composer to list the skills fx finds in its skill folders, in the order fx's own skill menu shows them.

## Permission modes

fx offers two composer modes.

| Mode           | Behavior                                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| **Supervised** | fx asks before it changes files or runs commands. Read requests run without asking. |
| **Auto**       | fx handles routine actions itself. Anything it still asks about reaches you.        |

T3 Code does not offer **Full access**, **Auto-accept edits**, or Plan mode for fx. A thread already set to one of those runs in **Supervised**. Changing the permission mode restarts the connection and reloads the same fx session.

On fx versions after [vercel-labs/fx#1189](https://github.com/vercel-labs/fx/pull/1189), a mode written over ACP becomes fx's default permission mode. fx in the terminal then starts in that mode.

By default, a message sent while fx works queues. With **Follow-up behavior** set to Steer, or with `Cmd+Enter`, it interrupts the turn and fx restarts with the new message.

## Not supported yet

- Plan mode.
- **Full access**.
- **Auto-accept edits**.
- Commit messages, pull request text, branch names, and thread titles. Pick another provider for those.

See [provider setup](./install.md#providers) and [Permission modes](./permission-modes.md).
