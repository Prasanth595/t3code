# Install and run

The factory runs in a T3 server started by a macOS LaunchAgent. The desktop app is optional: it is a window onto that server, and runs no factory of its own. Both are built from a clone of this repo on an Apple silicon Mac.

## Before you start

- Clone [original-solutions/t3code-factory](https://github.com/original-solutions/t3code-factory) and run `vp i` in it.
- Install current stable Rust (`rustup update stable`). The build compiles a small native helper.
- Log in a GitHub CLI config directory as the login the factory will act as:

  ```sh
  GH_CONFIG_DIR=~/.config/t3fac/gh gh auth login
  GH_CONFIG_DIR=~/.config/t3fac/gh gh api user --jq .login
  ```

  The LaunchAgent sets `GH_CONFIG_DIR` to this directory, so the server, its gates and its agent sessions all act as this login.

## Install the server

From a clean checkout, build and install in one step:

```sh
factory/scripts/deploy.sh
```

It builds `release/t3fac-<version>-darwin-arm64.tar.gz`, smoke-tests it, then installs it: the archive is unpacked under `~/.local/share/t3fac/versions/`, `~/.local/share/t3fac/current` points at it, and the LaunchAgent `io.github.rawphp.t3fac` restarts the server on port 3876 with its data in `~/.config/t3fac`. A second LaunchAgent, `io.github.rawphp.t3fac.logrotate`, rotates the log.

`deploy.sh` reuses an archive already built for the same commit. Pass `--rebuild` to build again, or `--build-only` to stop before installing. [Scripts](/agents/scripts) lists every script and its exit codes.

The install waits up to 90 seconds for the server to answer on port 3876 and to log `factory started` or `no factory config`. If it doesn't, the install rolls back to the previous version and exits 1. With no [machine config](/guide/machine-config) yet, the server logs `no factory config` and the factory stays idle.

### Tools the server can see

launchd gives the server only the `PATH` its plist sets, which covers Homebrew, `/usr/bin` and `vp`. Gates and sessions often need more, such as `claude`, `cargo`, `php` or `composer`. Put those in `~/.config/t3fac/env`, which the job sources before it starts the server:

```sh
PATH="$PATH:$HOME/.cargo/bin"
export PATH
```

Check what the running job has with `launchctl print gui/$(id -u)/io.github.rawphp.t3fac`.

## Install the desktop app

```sh
vp run dist:desktop:dmg:arm64
```

The dmg lands under `release/`. It is unsigned, so the first time you open the app, right-click it and choose Open. It installs beside upstream T3 Code as `T3 Code Factory` and shares no data with it or with the LaunchAgent server.

The app's built-in server runs no factory. To see the factory in the app, pair the LaunchAgent server as an environment in Settings → Connections, with a pairing link from:

```sh
~/.local/share/t3fac/current/t3 pair --base-dir ~/.config/t3fac
```

Add `--tailscale` for a link that works over your tailnet, for example from a phone's browser. The Factory pages are part of the fork's web app, so any browser paired with the server can open them. A connection through T3 Connect (the relay) doesn't reach them yet. [Remote access](https://github.com/pingdotgg/t3code/tree/main/docs/user/remote-access.md) covers pairing in general.

## Logs

| File                                          | What it holds                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `~/Library/Logs/t3fac/t3fac.log`              | The server's output, including each factory pass. Rotated at 20 MB, five copies kept. |
| `~/Library/Logs/t3fac/logrotate.log`          | One line per rotation.                                                                |
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

## Restart without installing

A paired session with the `environment:maintain` scope can restart the server:

```sh
curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:3876/api/factory/restart
```

launchd starts it again about 10 seconds later, on the version `current` points at. A gate that was running is killed, and the next pass runs it again from a fresh checkout.
