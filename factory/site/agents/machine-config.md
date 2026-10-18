# Machine config

File: `<base dir>/factory/config.yml`, by default `~/.config/t3fac/factory/config.yml`. Parsed by [`apps/server/src/factory/config.ts`](https://github.com/original-solutions/t3code-factory/blob/main/apps/server/src/factory/config.ts) (`parseMachineConfig`). Example: [`factory/config.example.yml`](https://github.com/original-solutions/t3code-factory/blob/main/factory/config.example.yml).

## Schema

| Key                    | Type         | Required | Default | Rule                                       |
| ---------------------- | ------------ | -------- | ------- | ------------------------------------------ |
| `gh_config_dir`        | string       | yes      |         | Non-empty. Full path; `~` is not expanded. |
| `poll_seconds`         | integer ≥ 10 | no       | `60`    |                                            |
| `max_concurrent_runs`  | integer ≥ 1  | yes      |         | Across all repos.                          |
| `max_concurrent_gates` | integer ≥ 1  | no       | `2`     |                                            |
| `notify`               | boolean      | no       | `true`  | macOS notification per new attention item. |

| Retired key      | Load result                       |
| ---------------- | --------------------------------- |
| `model_instance` | Warning. Kept by a settings save. |
| `model`          | Warning. Kept by a settings save. |
| `repos`          | Warning. Kept by a settings save. |

Any other top-level key: error `unknown key <key>`.

Errors print as `<file>: <field>: <message>`. A missing file means the factory is idle (`no factory config`); a file with errors means the factory is idle and an attention item `config` is open.

## Reload

| Event                                               | Reads the file                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Server start                                        | yes                                                                                     |
| `PUT /api/factory/config` (Settings → Factory save) | yes, after validating; a failing body is 422 `invalid_config` and the file is unchanged |
| Hand edit                                           | no; applies at the next save or restart                                                 |

| Key                    | Applies after a save                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poll_seconds`         | at once                                                                                                                                                                                                                                                                         |
| `max_concurrent_runs`  | next pass                                                                                                                                                                                                                                                                       |
| `max_concurrent_gates` | next pass                                                                                                                                                                                                                                                                       |
| `notify`               | next attention item                                                                                                                                                                                                                                                             |
| `gh_config_dir`        | next pass, for the factory's own `gh` calls. Sessions use the server's `GH_CONFIG_DIR` env (set in `factory/launchd/io.github.rawphp.t3fac.plist`): edit it there, then run `install.sh` on the built archive (`deploy.sh` refuses the uncommitted edit until it is committed). |

Settings → Factory edits `gh_config_dir`, `poll_seconds`, `max_concurrent_runs`, `max_concurrent_gates`. It keeps `notify` and the retired keys, and drops unknown keys.

## Data dir

| Path under `~/.config/t3fac/factory` | Content                                 |
| ------------------------------------ | --------------------------------------- |
| `config.yml`                         | This file.                              |
| `runs/<run id>.jsonl`                | Run ledger.                             |
| `events.jsonl`                       | Machine log.                            |
| `attention.json`                     | Open and dismissed attention items.     |
| `claims-paused`                      | Exists while claims are paused.         |
| `stop-requests/<run id>`             | Pending stop request.                   |
| `watched-projects.json`              | T3 projects each repo was watched from. |
| `gates/<run id>.lock`                | Exists while that run's gate runs.      |
