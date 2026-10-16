# Subpolar environment administration

The `subpolar` command manages environments through the authenticated Subpolar manager API. It does not open Docker or filesystem access directly. Configure:

- `SUBPOLAR_MANAGER_URL`
- `SUBPOLAR_MANAGER_TOKEN` (at least 32 characters)
- `SUBPOLAR_STORAGE_ROOT`
- optionally `SUBPOLAR_OWNER_ID` (defaults to `t3-installation`)

Commands:

```sh
subpolar status [--json]
subpolar environments list [--owner-id ID] [--json]
subpolar environments inspect /workspaces/project/worktree [--json]
subpolar environments start /workspaces/project/worktree [--json]
subpolar environments stop /workspaces/project/worktree [--json]
subpolar environments restart /workspaces/project/worktree [--json]
subpolar environments rebuild /workspaces/project/worktree [--json]
subpolar environments remove /workspaces/project/worktree [--json]
subpolar environments reconcile [--json]
```

`rebuild` replaces the environment container and starts a new one while leaving the worktree files in place. `remove` deletes the environment registration and container, not the T3 worktree. Exit code `2` means invalid command or configuration, `4` means the requested environment was not found, and `1` means the manager request failed or reconciliation reported failures.
