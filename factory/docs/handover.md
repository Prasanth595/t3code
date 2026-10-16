# Handover: switching this repo from the Rust factory to the fork's factory

A person does this switch, once, after the handover issue (#21) merges. Nothing here is run by an agent, and nothing in the repo writes to `~/.config`.

## 0. What the switch is

Today the Rust factory (softfac, LaunchAgent `io.github.rawphp.softfac`, T3 server on port 3874) watches `original-solutions/t3code-factory` from the clone `~/factory/original-solutions/t3code-factory` and builds the fork's issues. After the switch the fork's own factory (LaunchAgent `io.github.rawphp.t3fac`, port 3876, data in `~/.config/t3fac/factory`) watches the repo from a separate clone, `~/EA/projects/t3code-factory-fac`, and builds its own issues.

The rule is one factory per repo. Both factories use the same `factory:*` labels, the same assignee and the same comment markers, so two factories watching one repo would claim each other's issues. Between step 4 and step 6 neither factory watches the repo. That gap is safe: a `factory:ready` issue waits. The machine config is written in step 5, after the repo has left the Rust factory's config in step 4, because the fork's server reads that file on every start and launchd restarts the server by itself: with the file in place earlier, the fork would watch the repo alongside the Rust factory.

`apps/server/src/factory/e2e.test.ts` runs one issue from `factory:ready` to `factory:pr-open`, and one whose gate fails once, against a fake GitHub and a replayed model. Step 7 proves it against the real ones, on this machine.

## 1. Before the switch: build, install, and check the server's environment

Build on a clean tree (`build.sh` refuses a dirty one) and install. `build.sh` prints the archive's path, `release/t3fac-<version>-darwin-arm64.tar.gz` under the repo root:

```sh
factory/scripts/build.sh
factory/scripts/install.sh release/t3fac-<version>-darwin-arm64.tar.gz
```

With no machine config yet, the server logs `no factory config` and the install's health check passes on that line. The health check, how to tell the fork is down and how to roll back are in [README.md](../README.md#recovery).

The server and the agent sessions it starts run as whatever environment the LaunchAgent gives them, so check three things before going on.

### The GitHub login

The plist sets `GH_CONFIG_DIR=$HOME/.config/t3fac/gh`, so the fork's server, its gate and its sessions act as the login in that directory, and that login must be `rawphp`. Log in to the directory once, as rawphp:

```sh
GH_CONFIG_DIR=~/.config/t3fac/gh gh auth login
```

or copy the Rust factory's login: `cp -R ~/.config/softfac/gh ~/.config/t3fac/gh`. Then check it:

```sh
GH_CONFIG_DIR=~/.config/t3fac/gh gh api user --jq .login
```

It must print `rawphp`. The machine config's `gh_config_dir` (step 5) names the same directory. A session that finds another login stops the run with `the session ran as the wrong GitHub account`.

### `vp` and `claude` on the server's PATH

launchd gives a job only the `PATH` its plist sets. The gate runs `vp` (`factory/scripts/check.sh`, and `vp i` to provision), and every session needs `claude`. Print the environment the running job has:

```sh
launchctl print gui/$(id -u)/io.github.rawphp.t3fac
```

Look at `environment` for `PATH` and `GH_CONFIG_DIR`, then check that each program resolves on exactly that `PATH`:

```sh
PATH='<the PATH from launchctl>' command -v vp claude git gh
```

The template ends the `PATH` with `~/.local/share/vite-plus/bin`, where `vp` is. On this Mac `claude` is not on the template's `PATH`: it is in Herd's nvm bin directory (`dirname "$(command -v claude)"` in a login shell, a path with a node version in it), which is why the Rust factory's `~/.config/softfac/t3-serve.sh` searches for it. If `claude` does not resolve, T3 reports ``Claude Agent CLI (`claude`) was not found on PATH`` and every launch fails. Add that directory to the `PATH` string in the template `factory/launchd/io.github.rawphp.t3fac.plist`, commit it (the next `build.sh` needs a clean tree), and run `factory/scripts/install.sh` on the archive again: `install.sh` writes the installed plist from the template, so a change made only in `~/Library/LaunchAgents` is lost on the next install or rollback. The directory changes when Herd's node does.

### The model proxy

The Rust factory's T3 server (`~/.config/softfac/t3-serve.sh`) also sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, so its sessions' model calls go through a proxy. The fork's server sets neither and uses the machine's own Claude login. To use the proxy, those two variables would have to go into the plist template's `EnvironmentVariables`, and the template is committed to the repo, so the token must not be written there. Decide how the fork gets it before relying on the proxy.

## 2. Make the separate clone and its T3 project

```sh
git clone https://github.com/original-solutions/t3code-factory ~/EA/projects/t3code-factory-fac
```

The path must be a clone of its own, never the Rust factory's. Then add it as a project on the fork's T3 server. The factory finds a repo's project by its workspace root, and `FactorySessions.findProject` compares the path exactly, so the project's path must be character for character the `path` in the config. Open `http://127.0.0.1:3876`, pair the browser with the `Pairing URL:` line the server wrote to `~/Library/Logs/t3fac/t3fac.log` when it started (it holds a one-time token; do not paste it anywhere), and add a project at `/Users/tomkaczocha/EA/projects/t3code-factory-fac`.

`apps/server/src/cli/project.ts` also has `t3 project add <path> --base-dir ~/.config/t3fac` for a running server. It is read from the source, not run on this install.

If the project is missing when the factory claims an issue, the launch fails (`no T3 project for this repo on this machine` in the run's ledger) and the issue goes to `factory:stuck`.

## 3. Check that no run holds an issue of this repo

Every one of these must show nothing for `original-solutions/t3code-factory` that is working:

```sh
softfac runs list
gh issue list --repo original-solutions/t3code-factory --label factory:building
gh issue list --repo original-solutions/t3code-factory --label factory:triage
```

In `runs list`, a run of `original-solutions__t3code-factory__<issue>__<attempt>` with status `running` is still working: wait for it or stop it (`softfac runs stop <run>`). A `watching` run is a draft pull request that waits for a person. It does not block the switch, but the fork's factory does not know the run: merge or close that pull request by hand as before.

## 4. Take the repo out of the Rust factory

Remove the `original-solutions/t3code-factory` entry (`repo`, `path` and `user`) from `repos` in `~/.config/softfac/config.yml`, then restart the Rust factory so it rereads the file:

```sh
launchctl kickstart -k gui/$(id -u)/io.github.rawphp.softfac
```

## 5. Write the machine config

```sh
mkdir -p ~/.config/t3fac/factory
cp factory/config.example.yml ~/.config/t3fac/factory/config.yml
```

The example watches `original-solutions/t3code-factory` from `/Users/tomkaczocha/EA/projects/t3code-factory-fac` and runs one session at a time. Change a value if this machine differs. No path is expanded, so there is no `~` in the file. Do this only now, after the repo has left the Rust factory's config (step 4). The server reads the file whenever it starts, and launchd restarts it on its own (a crash, a login, a reboot, `install.sh`, `rollback.sh`), so a live config written earlier would have the fork watching the repo while the Rust factory still does.

## 6. Start the fork's factory

```sh
launchctl kickstart -k gui/$(id -u)/io.github.rawphp.t3fac
tail -n 50 ~/Library/Logs/t3fac/t3fac.log
```

Look for `factory started` after the restart. A config error instead is logged as `<file>: <field>: <message>`, and the factory stays idle. Each pass then logs a line such as `pass done: 0 runs, 0 claimed, 0 errors, 0 need attention`.

## 7. Prove it on one issue

Set a small issue of the repo to `factory:ready`, as an instructor (`.dw/config.yml` lists them). Watch the log, and read the run the way the Rust factory's runs are read: the ledger has the same format, so softfac's CLI reads it.

```sh
softfac runs list --data-dir ~/.config/t3fac/factory
softfac runs show original-solutions__t3code-factory__<issue>__1 --data-dir ~/.config/t3fac/factory
```

A good run goes `factory:ready`, `factory:triage`, `factory:building`, then `factory:pr-open`, and `runs list` shows it as `running` and then `watching`, with its pull request. If something is wrong, hand the repo back (below) until it is fixed.

## 8. Handing it back and moving it back

### Handing this repo back to the Rust factory

Do this when every installed version has a bug that stops the fork from building its own fix. It is the reverse of the #21 switch. A factory keeps watching the repos it read at its last start, so the order matters: the fork lets go of the repo before the Rust factory takes it.

1. Check that no run of either factory holds an issue for this repo: `softfac runs list` for the Rust factory, `softfac runs list --data-dir ~/.config/t3fac/factory` for the fork, and `gh issue list --repo original-solutions/t3code-factory --label factory:building` and `--label factory:triage` both come back empty.
2. Remove `original-solutions/t3code-factory` from `repos` in `~/.config/t3fac/factory/config.yml`. When it is the only repo there, move `config.yml` aside instead (`mv ~/.config/t3fac/factory/config.yml ~/.config/t3fac/factory/config.yml.off`): an empty `repos` is a config error, which fails every later health check, while a missing config logs `no factory config` and passes.
3. Restart the fork (`launchctl kickstart -k gui/$(id -u)/io.github.rawphp.t3fac`) and check `~/Library/Logs/t3fac/t3fac.log` for `no factory config`, or for `factory started` when other repos stay, after the restart.
4. Only then add the repo to `repos` in `~/.config/softfac/config.yml` with `repo`, `path` and `user`, and restart the Rust factory (`launchctl kickstart -k gui/$(id -u)/io.github.rawphp.softfac`).

The Rust factory then builds the fix.

### Moving it back

Once `install.sh` has installed a fixed archive and it passed its health check, run steps 3 to 7 again, in their order: check that no run holds an issue, remove the repo from `~/.config/softfac/config.yml` and restart the Rust factory, and only then add the repo to `repos` in `~/.config/t3fac/factory/config.yml` (or move `config.yml.off` back to `config.yml`) and restart the fork. launchd can restart the fork at any time, so the config goes back only after the Rust factory has let go of the repo.
