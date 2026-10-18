# The machine config

The machine config says how the factory runs on this Mac: which GitHub login it uses, how often it checks GitHub, and how much it does at once. It lives in `~/.config/t3fac/factory/config.yml`. Repos are not listed here: [Add a repo](/guide/add-a-repo) covers how a repo is watched, and the model comes from the T3 project.

Without the file, the server starts and the factory stays idle. Start from [`factory/config.example.yml`](https://github.com/original-solutions/t3code-factory/blob/main/factory/config.example.yml) in the repo, or save the form at Settings → Factory with the factory's server selected, which creates it.

```yaml
gh_config_dir: /Users/you/.config/t3fac/gh
poll_seconds: 60
max_concurrent_runs: 1
max_concurrent_gates: 1
notify: true
```

## Keys

| Key                    | Required | Default | What it does                                                                                                                                                                                                                |
| ---------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh_config_dir`        | yes      |         | The GitHub CLI config directory the factory acts through. Write the full path: nothing in this file expands `~`.                                                                                                            |
| `poll_seconds`         | no       | `60`    | Seconds between passes over GitHub, at least 10. A session ending or a gate finishing starts a pass at once, so this is only the longest wait for news from GitHub.                                                         |
| `max_concurrent_runs`  | yes      |         | Runs that may hold an issue at once, across every repo, at least 1. A run holds a slot from its claim until its session reports a pull request or the run ends. The gate and the wait for required checks take no run slot. |
| `max_concurrent_gates` | no       | `2`     | Gates that may run at once, at least 1.                                                                                                                                                                                     |
| `notify`               | no       | `true`  | Posts a macOS notification when something needs a person. `false` keeps the list on the Factory page and turns the notification off.                                                                                        |

Any other key is an error, and the factory stays idle until it is fixed. Three keys from older versions, `model_instance`, `model` and `repos`, load with a warning instead: the current version ignores them, and a save from Settings → Factory keeps them, so a rollback to a version that needs them still starts. Delete them once you won't roll back that far.

## Changing it

Settings → Factory edits `gh_config_dir`, `poll_seconds`, `max_concurrent_runs` and `max_concurrent_gates`. Edit `notify` in the file by hand. A save checks the whole file with the same rules the server uses at start and refuses one that would fail, so a bad value never reaches disk from the page.

The server reads the file when it starts and each time Settings → Factory saves it. It doesn't watch the file, so a hand edit takes effect at the next save from the page or the next restart.

What a save changes without a restart:

| Change                                        | Takes effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poll_seconds`                                | At once: a save starts a pass, and the next wait uses the new value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `max_concurrent_runs`, `max_concurrent_gates` | From the next pass. A pass already running finishes with the old values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `notify`                                      | For the next item that needs attention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `gh_config_dir`                               | For the factory's own GitHub calls, from the next pass. Agent sessions take their login from the server's `GH_CONFIG_DIR` instead, which the LaunchAgent sets. Change both together: edit `GH_CONFIG_DIR` in `factory/launchd/io.github.rawphp.t3fac.plist` in your clone, then run `factory/scripts/install.sh release/t3fac-<version>-darwin-arm64.tar.gz` on the archive already built, which writes the plist from the edited file and restarts the server. `deploy.sh` refuses the uncommitted edit, so commit it first if you deploy instead. A session that runs as another login stops the run with `factory:stuck`. |

A file that fails to load, at start or after a hand edit and restart, leaves the factory idle with the errors in the log and on the Factory page as an item that needs attention.
