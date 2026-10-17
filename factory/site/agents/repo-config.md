# Repo config

File: `.dw/config.yml` in the repo. Parsed by [`apps/server/src/factory/config.ts`](https://github.com/original-solutions/t3code-factory/blob/main/apps/server/src/factory/config.ts) (`parseProjectConfig`).

## Where it is read

| Purpose                     | Source                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the repo is watched | The T3 project's checkout on disk; falls back to `git show origin/HEAD:.dw/config.yml`. Opted in when the root and `factory` are both mappings. Not validated here. |
| The config runs use         | The tip of the repo's default branch on GitHub, read on every pass.                                                                                                 |

## Schema

```yaml
factory:
  instructors: [login, ...] # required
  base: main # required
  provision: [cmd, ...] # required, may be []
  gate: [cmd, ...] # required
  required_checks: [name] # optional
  limits: # required mapping
    gate_retries: 2 # required
    minutes: 180 # optional
    regates: 5 # optional
    checks_minutes: 30 # optional
    interruption_resumes: 2 # optional
  autonomy: pr # required
```

| Key                                   | Type            | Required | Default | Rule                                                                         |
| ------------------------------------- | --------------- | -------- | ------- | ---------------------------------------------------------------------------- |
| `factory`                             | mapping         | yes      |         |                                                                              |
| `factory.instructors`                 | list of strings | yes      |         | Non-empty list; no empty strings. GitHub logins, matched case-insensitively. |
| `factory.base`                        | string          | yes      |         | Non-empty. Must equal the repo's default branch, or the repo is skipped.     |
| `factory.provision`                   | list of strings | yes      |         | May be empty. Shell commands.                                                |
| `factory.gate`                        | list of strings | yes      |         | Non-empty. Shell commands.                                                   |
| `factory.required_checks`             | list of strings | no       | `[]`    | GitHub check names.                                                          |
| `factory.limits`                      | mapping         | yes      |         |                                                                              |
| `factory.limits.gate_retries`         | integer ≥ 0     | yes      |         |                                                                              |
| `factory.limits.minutes`              | integer ≥ 1     | no       | `180`   |                                                                              |
| `factory.limits.regates`              | integer ≥ 1     | no       | `5`     |                                                                              |
| `factory.limits.checks_minutes`       | integer ≥ 1     | no       | `30`    |                                                                              |
| `factory.limits.interruption_resumes` | integer ≥ 0     | no       | `2`     |                                                                              |
| `factory.autonomy`                    | string          | yes      |         | Only `pr`.                                                                   |

Keys the server does not read are ignored.

## Limits

| Key                    | Counts                                                                                                                       | On running out                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `minutes`              | Minutes the run spent in `triage` and `building`. `pr-open` is not counted.                                                  | `stuck`: "the run passed its time limit"                             |
| `gate_retries`         | Gate or required-check failures sent back to the session. `0`: the first failure is final. Reset after a pass.               | `stuck`: "the gate failed after N attempts"                          |
| `regates`              | Gate reruns because the base branch moved.                                                                                   | `stuck`: "the base branch kept moving and the gate could not settle" |
| `checks_minutes`       | Wait for `required_checks` after the gate commands pass.                                                                     | `stuck`                                                              |
| `interruption_resumes` | Resumes or relaunches after a session ended `failed` or `cancelled`, or its thread vanished, when T3 trouble is in evidence. | `stuck`                                                              |

## Gate

| Step        | Detail                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Checkout    | Fresh clone of the PR head merged with the base branch tip. A merge conflict fails the attempt. |
| Commands    | Each `provision` command, then each `gate` command, through the shell, at the checkout root.    |
| Timeout     | 30 minutes per command.                                                                         |
| Pass        | Every command exits 0. Then `required_checks`, if any, must pass on the gated commit.           |
| Source      | The commands come from the default branch, never from the PR.                                   |
| Environment | The server's: the LaunchAgent `PATH` plus `~/.config/t3fac/env`.                                |
