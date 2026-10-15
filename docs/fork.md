# Fork releases

This fork ([Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code)) publishes its own desktop builds and server archives.
The installed app and the headless servers update themselves from the fork releases through the upstream updaters.
Agents that operate the machines, the machine map or the deploys start with [fork-agents.md](fork-agents.md).
Each fork behavior is a setting. A setting that only adds something starts on. A setting that changes existing behavior or layout, installs or restarts anything, changes access or needs setup starts off. The machine map sets the values of the owner's machines.

## How it works

Fork main only moves forward. Nothing rebases or force-pushes it.

- `.github/workflows/fork-sync.yml` merges `pingdotgg/t3code` main into fork main every day. It typechecks the merge, runs the fork tests and pushes it as a fast-forward. The fork tests are the test files that the fork changed since the last merged upstream commit, `git merge-base upstream/main HEAD`. A diff against a newer upstream main also lists files that only upstream changed. If main moved during the run, it merges the new main and pushes again.
- The fork disables every upstream workflow, because they need upstream's runners and secrets. Fork workflow files start with `fork-`. After each sync, the job "Check upstream workflows" fails when another workflow is active, and prints the `gh workflow disable` command for it.
- If the merge conflicts, the typecheck fails or a fork test fails, the sync comments on the issue "Fork sync: upstream merge failed" and stops.
- `.github/workflows/fork-release.yml` builds the desktop apps and the server archives. It runs on each push to main and on manual dispatch. A push that changes only `docs`, `*.md` or `apps/machine-map` builds no release; the next release lists its commits. If the commit already has a release, it stops early.
- Only one release run works at a time, and no run is cancelled, so a release is never half published. GitHub keeps one waiting run, and a newer push replaces it. Thus a burst of pushes builds only the running commit and the newest commit.
- `scripts/fork-release-notes.ts` writes the release notes from git: the first-parent commits on main after the previous release tag. A release after a burst lists every merge since that tag. Each line names its source, upstream or fork, and the fork pull requests come last, because the update popover shows the last lines first and drops headings.
- The release builds macOS arm64 (signed), Windows x64 (unsigned), and Linux x64 and arm64 AppImages (unsigned) at the same time, on GitHub-hosted runners. Each platform publishes to the release when its build is done, so the Mac does not wait for Windows.
- Each Linux build also publishes the server archive `t3-<version>-linux-<arch>.tar.gz`. The archive holds the `t3` single-executable, the web client and the native packages, so a machine without a display runs the server without Node: `t3 serve`.
- When both Linux archives are on the release, the job "Server checksums" uploads `SHA256SUMS` last. The upstream server updaters (`t3 update`, `t3 service install`, "Update everything") verify the archives against it. A release without `SHA256SUMS` is not ready for servers, and "Update everything" skips it. If `t3 update` picks a release that has no `SHA256SUMS` yet, it fails. Run it again when the release is done.
- `CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts` points the server updaters at the fork releases. `scripts/install.sh` installs from the fork releases, on the nightly channel by default.
- A manual run from a branch other than main does not publish a release. It uploads the files of each platform as workflow artifacts, for a test of release changes.
- The release carries `nightly-mac.yml`, `nightly.yml` (Windows), `nightly-linux.yml` (x64) and `nightly-linux-arm64.yml` for electron-updater. Until a platform adds its file, its apps find no update in the new release.
- If a sync, a release or a Fork CI run fails, its `notify_agent` job runs `scripts/fork-notify-agent.sh`. The script posts the run to `T3_AGENT_WEBHOOK_URL`, a webhook scheduled task on a T3 server that starts a repair agent. A manual run with `notify_agent=false` does not post. A failure right after a failure of the same workflow does not post either, when the notify job of the first failure succeeded, because the agent that it started watches the next run. The script retries the call once a minute for 15 minutes, so a webhook server restart does not lose it.
- `.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners for each push to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled on the fork.
- Fork CI also runs for each pull request to main. A newer push to main or to a pull request cancels the Fork CI run of the older push. The repair agent ignores a cancelled run.
- The "Fork CI result" job fails when any Fork CI job fails or is cancelled. Branch protection requires this one check. A pull request never calls the repair agent.
- Fork CI compares a push with the commit of the last green push run, and a pull request with its base. When only `docs`, `*.md` or `apps/machine-map` changed, only the Lint job runs, and it checks only the changed files. A change in `apps/machine-map` also runs the Machine map job: its typecheck and tests. A manual run always runs every job.
- To see all fork changes, run `git diff upstream/main...main`.
- The top of `README.md` lists the fork features and fixes, up to the first `---` line. A pull request that adds, removes or changes a fork feature or fix updates its line in that list.
- Settings > Fork shows every fork setting and each upstream setting that the fork changed, with the same rows as their usual pages. A pull request that adds a fork setting adds it to `FORK_SETTING_GROUPS` in `apps/web/src/components/settings/forkSettingsCatalog.ts` and its row component to `FORK_SETTING_ROWS` in `ForkSettings.tsx`. The catalog imports no components, because the settings search on every route reads it.
- "Restore device defaults" in Settings resets every fork preference, the list in `apps/web/src/components/settings/forkSettingsRestore.ts`. Like upstream, it keeps user data and access: global scripts and pins, sidebar groups, thread card layouts, the machine map, client access and tunnel pairing. A pull request that adds a fork preference adds it to that list.
- If a Fork Sync merge conflicts in `README.md`, keep the fork section on top and take the upstream text below the `---` line.
- A merge without conflicts can still break a fork feature. Each fork feature that changes upstream behaviour needs a test of that behaviour, so that the fork tests catch the break.

The builds use the `nightly` update channel, the app id `com.t3tools.t3code` and the data directory `~/.t3`.
They replace the upstream Nightly app and keep its data.

## App icon

The fork replaces the nightly icons with the Tick3d lightning icon. The source is `assets/fork/tick3d-macos.svg`. The desktop app, its notifications and the bundled web page use these files. The mobile app comes from upstream and keeps its icon. To change the icon, edit the SVG and run:

```sh
S=assets/fork/tick3d-macos.svg N=assets/nightly T=$(mktemp -d)
rsvg-convert -w 1024 -h 1024 $S -o $N/nightly-macos-1024.png && cp $N/nightly-macos-1024.png $N/nightly-universal-1024.png
rsvg-convert -w 180 -h 180 $S -o $N/nightly-web-apple-touch-180.png
for s in 16 32; do rsvg-convert -w $s -h $s $S -o $N/nightly-web-favicon-${s}x${s}.png; done
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s -h $s $S -o $T/$s.png; done
magick $T/{16,24,32,48,64,128,256}.png $N/nightly-windows.ico && cp $N/nightly-windows.ico $N/nightly-web-favicon.ico
```

## Versions

The version is `<upstream base version>-nightly.<UTC date>.<build number>`, for example `0.0.46-nightly.20261010.3`.
The build number is one integer, because the build and the app read the update channel from `-nightly.<date>.<number>`. CI uses the workflow run number times 10000, for example `0.0.46-nightly.20261011.180000`. A local build adds the minute of the UTC day (1 to 1440) to the newest CI number, for example `0.0.46-nightly.20261011.180845`. Thus a local build is newer than the CI release it follows, and older than the next CI release.

## macOS signing

The fork signs with the self-made certificate "Yarden Zamir T3 Fork". The fork does not notarize.
Squirrel.Mac installs an update only if the update has the same signature as the running app.
Thus, every build must use the same certificate.

- The certificate, the key and the `.p12` password are in `_shared/signing/` in the repository container. They are not in git.
- The repository secrets `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD` hold the same certificate.
- `T3CODE_DESKTOP_MAC_SELF_SIGNED=true` tells `scripts/build-desktop-artifact.ts` to skip the passkey entitlements. Passkeys need an Apple team.

The first install of a fork build must be manual. The upstream Nightly has another signature, so it cannot update to a fork build.
macOS blocks the first start of an app that is not notarized. To allow it, open the app with Control-click and select Open.

## Trust the certificate on your Mac

Do this one time before the first local build:

```sh
security import _shared/signing/cert.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -P "$(cat _shared/signing/p12-password.txt)"
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db _shared/signing/cert.pem
security find-identity -v -p codesigning
```

The last command must list "Yarden Zamir T3 Fork".

## Build locally

```sh
scripts/fork-desktop-mac.sh
```

The script writes the signed ZIP and `nightly-mac.yml` to `release/`. It skips the DMG, which only a first manual install uses.

## Install a local build on this Mac

A local build is the fast way to test a change on this Mac. It does not replace the normal flow: merge the change to main, and its CI release reaches every machine in minutes.

```sh
scripts/fork-desktop-mac.sh --install
```

The script quits T3, keeps the previous app in `_shared/backup/`, installs the new build and starts it. GitHub is not involved.
The next CI release replaces the local build through the updater.

## Publish a local build

Push the commit first. Then run:

```sh
scripts/fork-desktop-mac.sh --publish
```

The script creates a prerelease on the fork. Installed fork apps offer it as an update.

## Server updates

A headless server that runs as the upstream background service (`t3 service install`) updates from the fork releases. The install is the upstream self-update: it unpacks the release into `<T3 home>/runtime/versions/<version>`, and the service launcher starts it on trial. If the new version does not start, the launcher goes back to the old version.

- Turn on Settings > General > About > Server auto-update, the server setting `forkAutoUpdate` (default `false`). Then the server checks the fork releases every 5 minutes. When a newer release is ready and no agent turn or background shell runs, it installs the release.
- A release is ready when it has `SHA256SUMS`. A version that rolled back or failed is not tried again. A newer release is tried.
- The machine map command Install update (`installUpdate`) works on such a server too (MM-505). `whenIdle: false` installs the newest fork release now. `whenIdle: true` installs it at the first check with no running agent turn or background shell, also when `forkAutoUpdate` is off.
- A restart stops the running turns. The upstream setting "Continue threads after restarts" (`continueThreadsAfterServerUpdate`, on by default) and "Recover interrupted agents" continue them after the update.
- "Update everything" and `t3 update` also install fork releases. A self-update request for a version that has no fork release installs the newest fork release instead. The mobile app comes from upstream and offers upstream versions, so its "Check for updates" installs the newest fork release.
- The code is in `apps/server/src/fork/ForkUpdates.ts` and `apps/server/src/fork/forkReleases.ts`.

## Deploy a local build

To try a change on a headless server before a release, deploy a build of your checkout over SSH. The server must run as the background service. It takes a few minutes, not a release run.

```sh
scripts/fork-deploy-local.sh <ssh-host>
```

- The script reads the system of the server with `ssh <ssh-host> uname -sm`. It supports Linux x64 and arm64.
- It builds the web client and the `t3` executable for that system here. It takes the native packages and the resource monitor from the newest fork release that has `SHA256SUMS`.
- If the checkout changes `apps/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` or `patches` since that release, the script stops. Such a change needs a release.
- The version follows the rule of the Mac local build in "Versions": it sorts above the release it follows and below the next one. Thus `forkAutoUpdate` replaces it with the next release.
- On the server, the script unpacks the build into `<T3 home>/runtime/versions/<version>` and runs `t3 update <version> --yes`. The update checks that the new `t3` runs, then restarts the service at once. The restart stops running agent turns.
- Unlike a release update, this switch does not go back by itself when the new version does not start.
- `<T3 home>` is `~/.t3` of the SSH user, or `T3CODE_HOME` of the SSH session.
- To go back, run `t3 update <version> --yes --allow-downgrade` on the server with the earlier version. It is still in `runtime/versions`.
- To build only, run `scripts/fork-deploy-local.sh --archive linux-x64` or `--archive linux-arm64`. The archive is in `release/`.
- The script changes the version in the `package.json` files during the build and puts them back after it.

## Changelog

The client setting `forkChangelogEnabled` turns on a changelog of the fork. It is on by default. Turn it off in Settings > General > About > Fork changelog.

- Open it from the Fork changelog row in Settings, or from "Open changelog" in the update button popover on the desktop app. It opens also when no update is available.
- With the setting on, the update button popover shows the changelog rows of every release between the installed version and the offered one, in one scrolling list. Each release costs two GitHub requests. When GitHub does not answer, for example offline, the popover shows the release notes instead.
- The Releases tab is one timeline of commits, newest first. A thin divider shows each release, its time and an "Installed" mark. The commits that the release adds to the release before it follow the divider.
- The timeline shows 10 releases first. "Show older releases" adds 10 more, because each release costs GitHub requests.
- Each commit shows as its own row. A fork icon marks a fork commit, and a down-arrow icon marks an upstream commit. The author shows as a GitHub avatar. Each icon names its meaning in a tooltip. A range of more than 500 commits stops at 500 with a note.
- Each commit, release and Fork Sync run shows its time and the time since, for example "9:41 AM, 12th October 2026 · 3h ago". The time since updates once a minute while the changelog is open.
- The release version, commit sha, author, run and each job link to GitHub. A `#123` in a fork commit subject shows as a pull request badge that links to the fork pull request. In an upstream commit subject, it links to the upstream pull request. The badge uses the markup of the thread card pull request badge, so a theme rule for `[data-thread-card-element="pullRequest"]` styles both.
- A fork commit is a commit that `pingdotgg/t3code` main does not contain. Merge commits do not show.
- The Upstream tab lists the upstream main commits that fork main does not have yet, in the same rows. Its "Start Fork Sync" button starts `.github/workflows/fork-sync.yml` and shows the run and each job. The tab reads the run again every 5 seconds while the run is queued or running.
- The "Ask agent" menu opens a thread in the fork project of the same machine, like "Ask a question" on a pull request. The composer gets a changelog chip and a prompt to read and send. The Releases tab offers "Ask a question", "Summarize the changelog" and, when a newer release exists, "What changed since my version". The Upstream tab offers "Ask a question" and, when upstream commits wait, "Summarize upstream changes" and "Check the impact on the fork".
- The fork project is the first project whose repository is `Yarden-zamir/t3code`, either as the only remote or as `origin` beside an `upstream` remote. Without one, the menu shows an error.
- The server reads GitHub with the GitHub credential of its machine, the same one that pull requests use (settings, `GH_TOKEN` or `gh auth login`). Without a credential, the changelog shows the GitHub error.
- Starting Fork Sync needs the `source-control:write` scope on the connection.

## Install the fork

`scripts/fork-install/` installs the fork on a new machine and joins the machine map. The join dialog of the machine map shows these commands with the join code (MM-211).

```sh
curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash -s -- --join <code>
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1))) -Join <code>
```

- On macOS, `install.sh` downloads the newest nightly `.dmg`, copies the app to `/Applications` and opens it. It keeps an installed app, because the app updates itself. `--force` replaces it.
- On Windows, `install.ps1` downloads and runs the newest nightly `.exe`.
- With a join code, the app installs write it to `~/.t3/userdata/machine-map-join-code` (or below `T3CODE_HOME`). The app server joins with it at its next start and deletes it. If the app was open already, quit it and open it again. The code expires after 10 minutes.
- Both read the release list of the GitHub API, because the nightlies are pre-releases and `releases/latest` skips them.
- On Linux with a display (`DISPLAY` or `WAYLAND_DISPLAY`), `install.sh` downloads the newest nightly AppImage to `~/Applications/T3-Code.AppImage`, adds a menu entry and starts it. Like on macOS, it keeps an installed app and `--force` replaces it. The app updates itself from `nightly-linux.yml` or `nightly-linux-arm64.yml`. AppImages need FUSE 2, for example `sudo apt install libfuse2t64`.
- On Linux without a display, `install.sh` runs `scripts/install.sh`, the upstream installer pointed at the fork releases. It unpacks the newest release into `~/.t3/runtime/versions/<version>` and links `~/.local/bin/t3` to it. Then it runs `t3 service install`, the upstream background service `t3code.service`. The drop-in file `~/.config/systemd/user/t3code.service.d/fork.conf` keeps the server on `127.0.0.1:3773` with the PATH of the installer shell. Then it runs `t3 machine-map join <code>`. The machine needs no Node.
- The server updates itself, see "Server updates". `t3 update` also works. A restart stops the running agent turns of that server.
- On Linux without a display, `t3 service install` turns on lingering, so the server keeps running after logout. If that needs an administrator, it says so, see [background-service.md](user/background-service.md#troubleshooting).
- The join gives the machine its tunnel when the portal can make one (MM-213). See "Set up a headless Linux machine".
- Run `install.sh --help` for the options.

## Set up a headless Linux machine

These steps set up a Linux server without a display, for example an Oracle Cloud Ubuntu 24.04 machine on Ampere (arm64). Run them over SSH as the normal user, for example `ubuntu`. Do not run the installer with `sudo` or `su`, because the server runs as a systemd user service.

1. In the portal, click "Add machine". The join dialog shows the Linux command with the join code.
2. On the machine, run that command:

```sh
sudo apt-get update && sudo apt-get install -y curl tar ca-certificates libatomic1
curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash -s -- --join <code>
```

The installer starts the server and joins the map. The portal made a tunnel `t3-<name>.yarden-zamir.com` for the machine (MM-213). The server saves it, restarts once, installs the pinned `cloudflared` into `~/.t3/tools/cloudflared/` and runs it as a child process (MM-1309). The join dialog in the portal then shows that the machine joined.

- The join code expires after 10 minutes. If it expired, make a new code in the machine panel of the portal.
- The tunnel connects outbound, and the server listens only on `127.0.0.1`. Thus the cloud firewall needs no change. On Oracle Cloud, keep the default security list and the `iptables` rules of the image.
- To check the server, run `t3 service status` and `systemctl --user status t3code.service`. The `cloudflared` log is `~/.t3/userdata/logs/cloudflared.log`.
- The server updates itself when `forkAutoUpdate` is on, see "Server updates". To update it by hand, run `t3 update`.

### Set up the tunnel by hand

Use these steps only when the join dialog says "No tunnel", for example when the portal token lacks "Cloudflare Tunnel: Edit". A tunnel from the environment wins over the tunnel of a join (MM-1310).

1. In Cloudflare Zero Trust, create a tunnel, for example `t3-oracle`. Give it the public hostname `t3-oracle.yarden-zamir.com` with the service `http://127.0.0.1:3773`. Keep the tunnel token.
2. Make sure that the Access app "T3 Code servers" covers the new hostname.
3. Install `cloudflared` and run the tunnel as a system service:

```sh
curl -fsSLo /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
sudo dpkg -i /tmp/cloudflared.deb
sudo cloudflared service install <tunnel-token>
```

4. Give the server its tunnel hostname and the Cloudflare Access login. Copy the Access values from the server environment of the VPS. The subjects list holds the owner email and the client id of the service token that the desktop app uses for remote machines. Without that client id, the desktop app cannot open this machine. `t3 service install` and `t3 update` replace only the unit file, so this drop-in file stays after an update.

```sh
mkdir -p ~/.config/systemd/user/t3code.service.d
cat > ~/.config/systemd/user/t3code.service.d/tunnel.conf <<'EOF'
[Service]
Environment=T3CODE_TUNNEL_PAIRING_URL=https://t3-oracle.yarden-zamir.com
Environment=T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
Environment=T3CODE_CLOUDFLARE_ACCESS_AUD=<audience tag of the Access app>
Environment=T3CODE_CLOUDFLARE_ACCESS_SUBJECTS=<owner email>,<client id of the desktop service token>
EOF
systemctl --user daemon-reload && systemctl --user restart t3code.service
```

## Recover interrupted agents

Every agent runs as a child process of the T3 server. An update, a crash or a quit stops them all. When the setting is on, the next server start sends each stopped thread a short message, so that its agent continues.

- Turn it on in Settings > General > Recover interrupted agents. It is off by default.
- The server settings keys are `recoverInterruptedTurns` (default `false`), `recoverInterruptedTurnsMessage` (default "Recover and continue") and `recoverInterruptedTurnsSubagentMessage` (default "Recover and continue. Your parent thread was also restarted."). They are in `settings.json` in the T3 home `userdata` folder, for example `~/.t3/userdata/settings.json`.
- It extends the upstream setting "Continue threads after restarts" (`continueThreadsAfterServerUpdate`). When the fork setting is on, it replaces the upstream behavior with the configured messages. A project that turns "Continue threads after restarts" off gets no message.
- A thread gets the message when the restart stopped its turn, or when its turn was finished but background work of that turn was still open. Background work is a native subagent, a monitor or a background shell.
- A native subagent, for example a Claude Code Task subagent, lives inside the process of its parent agent. It is not a T3 thread and gets no message. The message to its parent thread covers it, together with a note that names the stopped work.
- A thread that another thread delegated work to gets the delegated thread message.
- No message goes to a thread that the user stopped, snoozed or settled, to a turn that ended on its own, to a turn that waited for an answer, an approval or a secret, to a turn that did not start, to a thread without a saved provider session, or to a thread with newer work. Held queued messages stay held.
- Each stopped turn gets one message at most. A recovery turn that a restart stops before it answers gets no second message. After three recoveries in a row, as upstream does, the thread waits for the user, so a restart loop stops.
- The thread shows the message as a "T3 Code restarted" notice. The agent receives the message text.
- The code is in `apps/server/src/orchestration-v2/RecoverInterruptedTurns.ts`.

## Pull requests from origin

The server setting `preferOriginRemote` makes a fork checkout count as its fork. It is off by default. Turn it on in Settings > Source control > Fork checkouts.

- Upstream T3 names a checkout by its `upstream` remote first, then `origin`. A fork checkout then lists, reads and watches the pull requests of the upstream repository, and never the ones of the fork.
- With the setting on, `origin` comes first. The pull request list, pull request details, watches and links use the fork. The sidebar groups the checkout under the fork in both cases.
- Pull request creation and the pull request of the current branch come from the GitHub provider. It follows gh's default repository, then `upstream`. Run `gh repo set-default <owner>/<fork>` in each fork checkout, so that these use the fork too. The setting does not change them. Revisit if a fork checkout without a gh default creates a pull request on upstream.

## App toggle shortcuts

The client setting `appToggleShortcuts` lists global keys that show and hide the desktop app. It is empty by default. Set it in Settings > General > App toggle shortcuts, for example `F17, Alt+Space`.

- A key brings the app to the front when it is in the background, and hides it when it is in front. On macOS it hides and unhides the whole app, which has no animation.
- Each entry is an Electron accelerator. The settings field rejects a key that Electron cannot name. The ISO section key `§` is one of them: map it to a function key, for example with Karabiner.
- If another app or feature already holds a key, the desktop app logs a warning and skips it.

## Repository owner filters

The client setting `repositoryOwnerFilters` filters lists by the owner of each repository: a GitHub account or organization. It is on by default. Turn it off in Settings > General > Repository owner filters.

- In the sidebar, the owner comes from the repository that groups the project. A fork checkout counts under the owner of the fork.
- On the pull request page, the owner comes from the repository that the pull requests come from. A fork checkout of `pingdotgg/t3code` counts under `pingdotgg`.
- The menus offer only owners whose projects have threads. The owner of a cloned repository without threads does not show.
- Pull request page: open Filters > Owner. Pick "Show only selected" or "Hide selected", then pick the owners.
- In the pull request search, type `org:` or `owner:` to show only an owner, and `-org:` or `-owner:` to hide an owner. A typed owner replaces the menu choice.
- Sidebar: click the building icon next to the project scope, pick "Show only" or "Hide", then pick the owners.
- While the sidebar filter is on, a chip under the header names it and counts the hidden projects. Click "is" or "is not" on the chip to flip it. Click × to clear it.
- The filter hides every thread of a hidden project. When a hidden thread waits for an approval or an answer, the chip shows how many, for example "2 need you".
- A project without a remote has no owner. "Show only" hides it, and "Hide" keeps it. In the sidebar, pick "No repository owner" to filter these projects.

## Pull request filter chips

The client setting `pullRequestFilterChips` shows the active pull request filters as chips above the list. It is on by default. Turn it off in Settings > General > Pull request filter chips.

- Each filter that the Filters menu, the provider menu or the project scope sets gets a chip, for example "State: Merged" or "Owner is not qlik-trial".
- Click "is" or "is not" on a chip to flip it. Owners, drafts and labels can flip. A label flips into a typed `-label:`, because the menu cannot exclude labels.
- Click × on a chip to remove that filter. Click "Clear all" to remove all of them.
- Typed qualifiers stay in the search box, so they get no chip. A menu filter that a typed qualifier replaces gets no chip, because it does not apply.
- When no pull request matches the menu filters, the empty list names them and offers "Clear filters". With search text, the empty list names the search instead.

## Snooze quick options

The client setting `snoozeQuickOptions` holds the choices of the snooze menus. It is empty by default, and the menus then show the built-in choices. Edit it in Settings > General > Snooze quick options.

- The list starts from the built-in choices. The first change saves the whole list. The reset button brings back the built-in choices.
- The list keeps at least one choice. To go back to the built-in choices, use the reset button.
- A choice snoozes for a number of minutes, hours or days, or until a time today, tomorrow or on the next given weekday.
- A choice for today shows while its time is more than an hour away. A choice that lands on the same time as an earlier one does not show.
- A blank label shows a label that names the choice, such as "In 3 hours" or "Tomorrow".
- The setting applies to the snooze button, the thread menu and the menu for selected threads, on web and desktop. The mobile app keeps the built-in choices.

## Sidebar groups

The client setting `sidebarGroupsEnabled` shows thread groups as tabs under the sidebar search. It is off by default. Turn it on in Settings > General > Sidebar groups.

- The first tab, "Threads", holds every thread that is in no group. A thread lives in one group, so the groups act like folders.
- Drag a thread onto a tab to move it into that group. Drag it onto "Threads" to take it out of every group. Drag it onto the empty end of the tab bar to make a new group. A drop on the tab that already holds the thread changes nothing.
- Click + to make an empty group. Right-click a tab, or click the sliders button of the open tab, to rename it, edit its rules, move it or delete it.
- Rules put threads in a group automatically. A thread matches a group when it matches every rule. Rules compare the repository, the repository owner, the status, the provider, who created the thread, its background work and its title.
- A repository rule compares the repository of the project, such as `github.com/yarden-zamir/t3code`. The same repository matches on every machine, also where its project has another id or path. A project without a remote has no repository.
- A thread lives in the group that you dragged it into. Otherwise it lives in the first group, from left to right, whose rules match. Otherwise it lives in "Threads". New threads follow the same order.
- A group without rules holds only the threads that you drag into it.
- A rule on "Group" makes a view. A view shows the threads of the groups that it names and holds no thread itself. Pick Group > "Any group" to make an "All" tab.
- A tab shows the status of its most urgent thread, with the icon and color of the thread row. A tab that waits for an approval or an answer, or has a failed thread, plays a short wiggle once and keeps its color.
- Settled and snoozed threads stay in their group, in its Settled and Snoozed shelves. They do not count in the tab status.
- Search covers every tab. When you open a thread from a link or a notification, the sidebar shows its tab.
- The client setting `sidebarGroupSingleThreadOpens` makes a group with one thread show that thread on its tab. A click opens the thread.
- The groups and the drag assignments are saved in the server setting `sidebarGroups` of the primary server. The machine map owns its sync: after a change saves, it becomes the shared value of the map (MM-411), and every machine on the map applies it. A machine without the map role `edit`, or off the map, keeps the change on its own server only.
- A drag writes an assignment only where the rules give another group. Assignments of deleted or archived threads go at the next change. An environment that is not connected keeps its assignments.
- A rule from a newer T3 version shows as "Rule: from a newer version". This version skips it.
- The client setting `sidebarGroupsEnabled` decides per device whether the tabs show. The open tab is also per device.
- A change replaces all groups at once. When two devices change groups at the same moment, the last change wins.
- The hosted app at app.t3.codes has no primary server to keep the groups, so it shows no tabs. The mobile app does not show groups yet.

## Thread card layouts

The server setting `threadCardLayouts` holds a custom thread card layout for desktop and web (`desktop`) and for the mobile app (`mobile`). Each value is `null` by default, and the card then keeps its built-in look. Edit it in Settings > Appearance > Thread cards.

- A layout is rows of elements. Each row has a left group that takes the free width and truncates, and a right group that keeps its size.
- Drag an element between groups, or into the Hidden tray to hide it. The title and the status cannot be hidden, because the status holds the settle and snooze controls.
- The setting is shared: a change goes to every connected server that supports shared settings, so the phone reads the same layout.
- The mobile tab offers no terminal or diff element. The preview shows the mobile arrangement with web styles, because the phone draws its cards natively.
- Every element of a custom layout carries `data-thread-card-element="<name>"`, so a theme CSS file can style one element, for example `[data-thread-card-element="terminal"] > *`.
- The layout schema and its edit operations are generic (`packages/contracts/src/slotLayout.ts`, `packages/shared/src/slotLayout.ts`). Another surface can reuse them with its own element list.
- Search results in the sidebar and the hosted app (app.t3.codes, which has no primary server) keep the built-in card.

## Pull request watch remark filter

The server setting `pullRequestWatchRemarkFilter` selects which comments and reviews wake an agent that watches a pull request. It is off by default. Turn it on in Settings > Source control > Pull request watch.

```json
"pullRequestWatchRemarkFilter": {
  "authorAssociations": ["OWNER", "MEMBER", "COLLABORATOR"],
  "authorLogins": [],
  "agentMarker": "<!-- agent -->"
}
```

- `authorAssociations` lists GitHub repository roles, the `authorAssociation` of the comment. A GitHub App bot has no such role.
- `authorLogins` lists logins that wake the agent whatever their role. The compare ignores case.
- When one of the two lists is not empty, a remark wakes the agent only if its author matches a role or a login. The rule that skips the server's own account does not apply then.
- When both lists are empty, the upstream rule applies: a remark wakes the agent unless the server's own account wrote it.
- A remark whose body contains `agentMarker` never wakes the agent, even from an allowed author.
- Only GitHub reports roles. On other hosts, a remark counts only through `authorLogins`.
- Check, conflict and push news and the comment wake limit do not change.
- The code is in `apps/server/src/orchestration-v2/pullRequestWatch.ts`.

## Worktree path template

The server setting `worktreePathTemplate` decides where new worktrees go. It is empty by default, and the worktree location setting then applies. Set it in Settings > Storage > Worktree path template.

| Variable       | Value                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| `{worktrees}`  | The worktree location setting, or `<T3 home>/worktrees`.                  |
| `{repoDir}`    | The parent of the Git common dir: the checkout, or the `.bare` container. |
| `{repo}`       | The folder name of `{repoDir}`.                                           |
| `{branch}`     | The branch name, with `/` changed to `-`.                                 |
| `{branchLeaf}` | The last part of the branch name.                                         |

- For a `.bare` container repository, use `{repoDir}/{branchLeaf}`. A worktree for `feat/api/qcdi-1234-auth` then goes to `<container>/qcdi-1234-auth`, next to `main/`. Git runs the global `post-checkout` hook, which links `_shared/`.
- In a normal clone, or in a linked worktree of one, a template path inside a checkout uses the default worktree location instead. The server logs this once per repository. So `{repoDir}/{branchLeaf}` works for both layouts. To place normal clone worktrees elsewhere, use `{worktrees}/{repo}/{branch}` or `{repoDir}/../{repo}-{branch}`.
- The template must hold `{branch}` or `{branchLeaf}`.
- With a template, an auto-named thread names its branch from the first six words of its first message, before the worktree exists. The static branch naming mode adds its prefix. There is no model rename later, so the folder and the branch keep the same name. A taken name gets a `-1`, `-2` suffix on the branch and the folder. When a branch such as `t3` blocks `t3/x`, the name becomes `t3-x`.
- A branch that you type, and a pull request branch, keep their names. If their folder already exists, the launch fails and names the folder. Use `{branch}` when different branches end in the same last part.
- While a template is set, T3 marks each worktree that it creates with a `t3-created` file in the worktree's folder in the Git common dir. Storage cleanup and review diffs trust that mark, because the worktree can be outside the managed worktree folders. Cleanup never removes a worktree without the mark outside those folders.

## Installed web app

Each server web app, such as `https://t3-vps.yarden-zamir.com`, installs as an app. Desktop Chrome and Edge show "Install" in the address bar. Android Chrome shows "Install app" in its menu. On iPhone, use Share > Add to Home Screen. The app has shortcuts for a new thread, pull requests and settings. On Android, long-press the app icon to see them.

The client setting `installedAppEnabled` adds a service worker. It is on by default. Turn it off in Settings > General > Installed app, in each browser and for each server.

- An offline page shows when the device is offline, or when the tunnel answers but the server is down.
- Android and iPhone show thread and review guide notifications. Turn on notifications in Settings > General first. The page must still run, so a closed app shows nothing.
- The app icon shows the same notification count as the browser tab icon.
- The worker caches only the offline page. Pages and build files come from the server, so a new build shows at once and Cloudflare Access can ask for a new sign-in.

## Machine map

The server setting `machineMap` connects this server to the machine map portal. It is off by default. The requirements are in `apps/machine-map/SPEC.md`, and the portal setup is in `apps/machine-map/README.md`.

- Agents use the machine map through the `machines_*` and `machine_tool_call` tools. See [fork-agents.md](fork-agents.md).
- Join: in the portal, "Add machine" shows a one-time join code. A machine without the fork installs it first with the step 0 command of the dialog, see "Install the fork". On the machine, enter it in Settings > Machines, run `t3 machine-map join <code>`, or ask an agent to use the `machines_join` tool. The join saves the machine token in the server secret store and turns `machineMap` on.
- The Machines panel in the right panel of a thread shows the map from `machines_read`, read only. Open it from the "+" menu of the panel or with "Show machines" in the command palette.
- Settings > Machines shows the connection status, the last error, the portal link, this machine's name, and the machines that it can use with their levels. "Leave" forgets the token and turns `machineMap` off. Join and leave need the `settings:write` scope.
- When the portal makes a tunnel for the machine (MM-213), the join saves it and the server runs `cloudflared` itself (MM-1309). A tunnel from the environment or the desktop settings wins (MM-1310).
- Each joined server trusts the browser origins of the other machines on the map (MM-1311). One browser page then reaches every machine without `T3CODE_TRUSTED_BROWSER_ORIGINS`. Explicit trusted origins stay in addition.
- The server keeps one outbound WebSocket to the portal. It applies its desired state (settings and arrows) live, and saves it, so a restart applies it before other machines can connect.
- The desktop app reads the machine map state of its own server. It acts only while that server is joined, because only then does the server send it the token headers.
  - It saves one environment for each machine that it can use, with the machine token as request headers for that origin only, and pairs it through `/api/auth/cloudflare-access/pairing-credential`. When the machine leaves the list, the app removes the environment and its headers. It pairs again once when the target ends the session after a level change. Environments that the user saved by hand stay as they are.
  - It applies the desired client settings and reports its current client settings. The server leaves out values that equal the desired ones, so the map does not see its own writes as local changes.
  - It runs `reloadWindows` and `installUpdate` and reports each result before it acts. `installUpdate` with "when idle" uses the install-when-idle wait. It also reports the version of a waiting update.
- Another machine signs in with its Cloudflare Access service token. The server gives it the scopes of the arrow from that machine, with the session subject `machine:<id>`. A level change ends that machine's sessions at once.
- Clients (MM-904 to MM-922) are browsers and phones of the owner, as cards on the map with their own arrows. The portal Clients view approves a waiting browser sign-in, and "Invite an app" gives a native app a QR code. Only the owner makes invites, in the portal, with the passkey step. The app joins once and gets its own Cloudflare Access service token. A machine gives that token the scopes of the client's arrow, with the session subject `client:<id>`, and ends its sessions when the level changes, the arrow expires or the client leaves. "Remove client" deletes the token in Cloudflare. Approvals and invites need a passkey step through Cloudflare independent MFA; see "Client approvals" in `apps/machine-map/README.md`.
- The server setting `clientAccess` (MM-916) decides which browsers get in through Cloudflare Access. It is `off` by default. `observe` gives a browser with a key of an approved client the scopes of its arrow, at most `standard`, and any other browser keeps the owner login (MM-917). `enforce` lets in only the browsers of approved clients, with the level of their arrows but never `access:write` or `relay:write` (MM-918). Change it per machine in the portal Settings view, with the passkey step (MM-919). Turn it on in this order:
  1. Update every machine to a build that knows `enforce`. An older machine skips the value, while the portal shows it as set.
  2. Set `observe` on every machine.
  3. In the Clients view, select "Sign out everywhere" (MM-903). Open sessions send no key, so they must sign in again.
  4. Sign in once on each device. Approve each waiting key in the Clients view, and check its arrows.
  5. Set `enforce` on ONE machine first. Open it from each device. Then set `enforce` on the other machines.
- The way back in, when `enforce` locks a browser out:
  - A machine with a desktop app: the desktop app always gets in. In its Settings > Machines, set "Client access" to `observe` or `off`. The change reaches the portal also after a restart, and the portal sends a push message.
  - A headless machine (a VPS): set `clientAccess` in the portal Settings view. Without the portal, connect with SSH, then set `"clientAccess": "off"` in its `settings.json`, or run `t3 pair` and open the pairing link.
  - Pairing links keep working on every machine.
- Only the desktop app of a machine changes its `clientAccess` and `machineMap` settings, and joins or leaves the map. A headless machine joins with `t3 machine-map join <code>` or the installer.
- Settings sync (MM-406, MM-411): every setting that a machine reports shows in the portal Settings view, without a shared value. A setting syncs to every machine, also an offline or a new one, once it has a shared value. On a machine with the map role `edit`, a change in T3 Settings with "All environments" selected sets the shared value. A change for one environment of a synced setting becomes the own value of that machine. A synced row shows a sync marker. Paths, secrets, project-keyed maps and the map connection stay on each machine.
- Deploy the portal: `.github/workflows/fork-machine-map-deploy.yml` tests and deploys it from main when `apps/machine-map` or its contracts change, with the GitHub secret `CLOUDFLARE_DEPLOY_TOKEN` (Workers Scripts and Workers Routes edit). Do not deploy by hand: a deploy from a branch rolls back main. The Worker needs the secrets `SECRET_KEY` and `CF_API_TOKEN`.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate.                                                                                                                                                                |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `T3_AGENT_WEBHOOK_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`                | secret, optional   | Webhook URL of the repair agent task, and the Cloudflare Access service token that the call needs. Without the URL, no agent is notified.                                                 |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
