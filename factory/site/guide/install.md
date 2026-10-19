# Install and run

The factory runs in a T3 server started by a macOS LaunchAgent. The desktop app is optional: it is a window onto that server. Both are built from a clone of this repo on an Apple silicon Mac.

## Before you start

- Clone [original-solutions/t3code-factory](https://github.com/original-solutions/t3code-factory) and run `vp i` in it.
- Install current stable Rust (`rustup update stable`). The build compiles a small native helper.
- Log in a GitHub CLI config directory as the login the factory will act as:

  ```sh
  GH_CONFIG_DIR=~/.config/t3fac/gh gh auth login
  GH_CONFIG_DIR=~/.config/t3fac/gh gh api user --jq .login
  ```

  The LaunchAgent sets `GH_CONFIG_DIR` to this directory, so the server's own GitHub calls and its agent sessions act as this login. Gate commands don't inherit `GH_CONFIG_DIR` ([Add a repo](/guide/add-a-repo)); a gate that calls `gh` must set it itself.

## Install the server

From a clean checkout, build and install in one step:

```sh
factory/scripts/deploy.sh
```

It builds `release/t3fac-<version>-darwin-arm64.tar.gz`, smoke-tests it, then installs it: the archive is unpacked under `~/.local/share/t3fac/versions/`, `~/.local/share/t3fac/current` points at it, and the LaunchAgent `io.github.rawphp.t3fac` restarts the server on port 3876 with its data in `~/.config/t3fac`. A second LaunchAgent, `io.github.rawphp.t3fac.logrotate`, rotates the log, and a third, `io.github.rawphp.t3fac.autodeploy`, [follows `main`](#follow-main) once you turn it on.

`deploy.sh` reuses an archive already built for the same commit. Pass `--rebuild` to build again, or `--build-only` to stop before installing. [Scripts](/agents/scripts) lists every script and its exit codes.

The install waits up to 90 seconds for the server to answer on port 3876 and to log `factory started` or `no factory config`. If it doesn't, the install rolls back to the previous version and exits 1. With no [machine config](/guide/machine-config) yet, the server logs `no factory config` and the factory stays idle.

### Tools the server can see

launchd gives the server only the `PATH` its plist sets, which covers Homebrew, `/usr/bin` and `vp`. Gates and sessions often need more, such as `claude`, `cargo`, `php` or `composer`. Put those in `~/.config/t3fac/env`, which the job sources before it starts the server:

```sh
PATH="$PATH:$HOME/.cargo/bin"
export PATH
```

Check what the running job has with `launchctl print gui/$(id -u)/io.github.rawphp.t3fac`.

## Follow main

Once it is on, the server follows `main` on its own. Every 10 minutes the autodeploy job fetches a clone kept for it, and when `origin/main` is not the installed commit it builds and installs that commit with `deploy.sh`, health check and rollback included. Each deploy restarts the server, so it waits while an agent is at work in any thread, yours or the factory's, while a factory run has a gate at work, or while a pass is running, and tries again on the next tick. A thread waiting on your answer doesn't hold it up.

A build that fails, or is still going after an hour, is tried again on the next two ticks; after the third failure that commit is left until `main` moves. A commit that fails its health check is left at once.

The job builds with its plist's `PATH`, which covers Homebrew, `vp` and `~/.cargo/bin` from rustup, plus anything `~/.config/t3fac/env` adds to it.

To turn it on, make a clone used for nothing else, and mint a token that can read the factory's status:

```sh
git clone https://github.com/original-solutions/t3code-factory ~/.local/share/t3fac/clone
~/.local/share/t3fac/current/t3 auth session issue --base-dir ~/.config/t3fac \
  --scope orchestration:read --ttl 365d --label autodeploy --token-only
```

Then add both to `~/.config/t3fac/env`. Leave out `export`, so the server and its sessions don't get the token:

```sh
T3FAC_AUTODEPLOY_CLONE="$HOME/.local/share/t3fac/clone"
T3FAC_AUTODEPLOY_TOKEN=<token>
```

When the token expires, the log says it cannot read the status and nothing deploys until you mint a new one.

A deploy or rollback you run by hand stays until `main` moves: the next tick leaves it in place and logs that it is doing so.

To turn it off, remove `T3FAC_AUTODEPLOY_CLONE` from `~/.config/t3fac/env`. To stop the job until the next install or rollback, run `launchctl bootout gui/$(id -u)/io.github.rawphp.t3fac.autodeploy`. To remove it, run that, then delete `~/Library/LaunchAgents/io.github.rawphp.t3fac.autodeploy.plist` and `~/.local/share/t3fac/autodeploy.sh`; a later install puts them back.

## Install the desktop app

```sh
vp run dist:desktop:dmg:arm64
```

The dmg lands under `release/`. It is unsigned, so the first time you open the app, right-click it and choose Open. It installs beside upstream T3 Code as `T3 Code Factory` and shares no data with it.

The app runs no server of its own. It opens onto the LaunchAgent server on port 3876, so install the server first and keep it running. The first time you open the app it asks for a pairing link. Make one with:

```sh
~/.local/share/t3fac/current/t3 pair --base-dir ~/.config/t3fac
```

Paste the link into the app. It remembers the pairing, so later launches open straight onto the server. If the server is down, the app can't load until it's back; use Try again, or wait for it to reconnect. The Factory pages in the app show that server directly.

Add `--tailscale` for a link that works over your tailnet, for example from a phone's browser. The Factory pages are part of the fork's web app, so any browser paired with the server can open them. A connection through T3 Connect (the relay) doesn't reach them yet. [Remote access](https://github.com/pingdotgg/t3code/tree/main/docs/user/remote-access.md) covers pairing in general.

## Logs

| File                                          | What it holds                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `~/Library/Logs/t3fac/t3fac.log`              | The server's output, including each factory pass. Rotated at 20 MB, five copies kept. |
| `~/Library/Logs/t3fac/logrotate.log`          | One line per rotation.                                                                |
| `~/Library/Logs/t3fac/autodeploy.log`         | One line per deploy, failed deploy or wait while [following main](#follow-main).      |
| `~/Library/Logs/t3fac/autodeploy-build.log`   | The build and install output of the latest autodeploy attempt.                        |
| `~/.config/t3fac/factory/events.jsonl`        | The factory's machine log: passes, skipped repos, errors, server starts and stops.    |
| `~/.config/t3fac/factory/runs/<run id>.jsonl` | One ledger per run. The run's page shows it.                                          |

To tell whether the server is up:

```sh
launchctl print gui/$(id -u)/io.github.rawphp.t3fac
tail -n 50 ~/Library/Logs/t3fac/t3fac.log
```

No `pid` line means the job isn't running. A non-zero `last exit code` with a growing `runs` count is a crash loop. A config error is logged as `<file>: <field>: <message>`, and the factory stays idle until it is fixed.

## Roll back

```sh
factory/scripts/rollback.sh
```

It points `current` back at the previous version, restarts the server and runs the same health check. With no previous version it exits 1; install an older archive from `release/` with `factory/scripts/install.sh <archive>` instead.

While [autodeploy](#follow-main) is on, the rollback lasts until `main` moves; then the new `main` is deployed. To stay on the older version past that, turn autodeploy off first.

## Restart without installing

A paired session with the `environment:maintain` scope can restart the server:

```sh
curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:3876/api/factory/restart
```

launchd starts it again about 10 seconds later, on the version `current` points at. A gate that was running is killed, and the next pass runs it again from a fresh checkout.
