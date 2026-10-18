# Fork operations

Maintainer procedures of the fork [Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code): releases, builds, installs, deploys and secrets.
User-facing fork features are in [features.md](features.md). Agents that operate the machines start with [fork-agents.md](../fork-agents.md).

## How the fork works

Fork main only moves forward. Nothing rebases or force-pushes it. To see all fork changes, run `git diff upstream/main...main`.

The fork disables every upstream workflow, because they need upstream's runners and secrets. Fork workflow files start with `fork-`.

### Fork Sync

`.github/workflows/fork-sync.yml` merges `pingdotgg/t3code` main into fork main every day.

- It typechecks the merge, runs the fork tests and pushes the merge as a fast-forward. If main moved during the run, it merges the new main and pushes again.
- The fork tests are the test files that the fork changed since `git merge-base upstream/main HEAD`. A diff against a newer upstream main also lists files that only upstream changed.
- A conflict only in `README.md` resolves by itself. See [Change the fork](#change-the-fork).
- If the merge conflicts, the typecheck fails or a fork test fails, the sync comments on the issue "Fork sync: upstream merge failed" and stops.
- After each sync, the job "Check upstream workflows" fails when another workflow is active. It prints the `gh workflow disable` command for that workflow.
- GitHub can start the daily run hours after its 03:17 UTC schedule. Before you merge upstream by hand, read [Repair agent](../fork-agents.md#repair-agent).

### Fork Release

`.github/workflows/fork-release.yml` builds the desktop apps and the server archives on each push to main and on manual dispatch.

- A push that changes only `docs`, `*.md` or `apps/machine-map` builds no release. The next release lists its commits. If the commit already has a release, the run stops early.
- Only one release run works at a time, and no run is cancelled, so a release is never half published. GitHub keeps one waiting run, and a newer push replaces it. A burst of pushes thus builds only the running commit and the newest commit.
- `scripts/fork-release-notes.ts` writes the release notes from the first-parent commits on main after the previous release tag. Each line names its source, upstream or fork. The fork pull requests come last, because the update popover shows the last lines first and drops headings.
- The release builds macOS arm64 (signed), Windows x64 (unsigned), and Linux x64 and arm64 AppImages (unsigned) in parallel, on GitHub-hosted runners. Each platform publishes when its build is done.
- Each Linux build also publishes the server archive `t3-<version>-linux-<arch>.tar.gz`. It holds the `t3` single executable, the web client and the native packages, so `t3 serve` runs without Node.
- When both Linux archives are on the release, the job "Server checksums" uploads `SHA256SUMS` last. The server updaters (`t3 update`, `t3 service install`, "Update everything") verify the archives against it. "Update everything" and `t3 update` skip a release without `SHA256SUMS`.
- The release carries `nightly-mac.yml`, `nightly.yml` (Windows), `nightly-linux.yml` (x64) and `nightly-linux-arm64.yml` for electron-updater. Until a platform adds its file, its apps find no update in the new release.
- A manual run from a branch other than main publishes no release. It uploads the files of each platform as workflow artifacts.
- `CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts` points the server updaters at the fork releases.

The builds use the `nightly` update channel, the app id `com.t3tools.t3code` and the data directory `~/.t3`. They replace the upstream Nightly app and keep its data.

### Fork CI

`.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners, for each push to main and each pull request to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled.

- A newer push to main or to a pull request cancels the Fork CI run of the older push.
- The job "Fork CI result" fails when any Fork CI job fails or is cancelled. Branch protection requires this one check.
- Fork CI compares a push with the commit of the last green push run, and a pull request with its base. When only `docs`, `*.md` or `apps/machine-map` changed, only the Lint job runs, on the changed files. A change in `apps/machine-map` also runs the Machine map job. A manual run always runs every job.
- The Lint job also runs `scripts/fork-check-doc-links.ts`. It fails on a relative link or an anchor that does not resolve in `README.md`, `docs/fork*`, `docs/fork/` or `apps/machine-map/*.md`.

### Repair agent

A failed Fork Sync, Fork Release or Fork CI run on main runs its `notify_agent` job, `scripts/fork-notify-agent.sh`. A pull request never calls it.

- The script posts the run to `T3_AGENT_WEBHOOK_URL`, the webhook task "Fork repair" on the VPS T3 server (`yarden-zamir-vps-2`), project "t3code fork" (`/root/Github/t3code/main`).
- The script retries once a minute for 15 minutes, so a server restart of the VPS does not lose the call. Each auto-update of the VPS restarts its server for about 20 seconds.
- A manual run with `notify_agent=false` does not post. A failure right after a failure of the same workflow does not post either, when the first notify job succeeded and the first failure started less than 6 hours before.
- The repair agent ignores a cancelled run.
- How the agent works, and how to stop it: [Repair agent](../fork-agents.md#repair-agent).

## Change the fork

- Put every fork behavior behind a setting. A setting that only adds something starts on. A setting that changes existing behavior or layout, installs or restarts anything, changes access or needs setup starts off.
- Put the schema field of a fork setting in `packages/contracts/src/forkSettings.ts`, not in the upstream `settings.ts`.
- Add a new fork setting to Settings > Fork: its entry in `FORK_SETTING_GROUPS` (`forkSettingsCatalog.ts`) and its row in `FORK_SETTING_ROWS` (`ForkSettings.tsx`). Add a fork preference to the reset list in `forkSettingsRestore.ts`.
- `forkSettingsRegistration.test.ts` fails when a fork setting has no Fork page row or no Restore defaults rule. A setting without a row needs a reason in that test.
- The top of `README.md`, up to the first `---` line, lists the fork features and fixes. Keep one line per feature, with a link to its section in [features.md](features.md). A pull request that adds, removes or changes a fork feature updates its line and its section.
- If a Fork Sync merge conflicts only in `README.md`, the sync keeps the fork section up to the first `---` line and takes the upstream README below it. A conflict in another file stops the sync.
- If a sync conflicts on a tooltip line with a `ShortcutHint` (the key chips in upstream tooltips), take the upstream line, then add one `ShortcutHint` back. If the same file conflicts again, keep the upstream tooltip text in that file.
- A merge without conflicts can still break a fork feature. Each fork feature that changes upstream behavior needs a test of that behavior, so that the fork tests catch the break.

## Check a change before you push

Run this command before every push:

```sh
vp run fork:check
```

- It runs the quick Fork CI checks on the files that changed since the merge base with `origin/main`. Uncommitted and untracked files count.
- The steps are format and lint of the changed files, knip, typecheck of the changed packages, the tests of the changed files, and the doc link check. The tests are the changed test files, the tests next to changed source files, `forkSettingsRegistration.test.ts`, the React Compiler coverage test of a changed web or mobile app, and the import cycle test (`dependency-graph.test.ts`) of a changed mobile app.
- It prints one line per step: pass, fail or skipped with the reason. It exits with an error when a step fails.
- Without Playwright Chromium, it skips the browser tests and prints the install command.
- Fork CI still runs the full test suites, the typecheck of dependent packages, the desktop build and the Rust crates.

## Versions

The version is `<upstream base version>-nightly.<UTC date>.<build number>`, for example `0.0.46-nightly.20261010.3`.

- The build number is one integer, because the build and the app read the update channel from `-nightly.<date>.<number>`.
- CI uses the workflow run number times 10000, for example `0.0.46-nightly.20261011.180000`.
- A local build adds the minute of the UTC day (1 to 1440) to the newest CI number, for example `0.0.46-nightly.20261011.180845`. A local build is thus newer than the CI release it follows, and older than the next CI release.

## App icon

The fork replaces the nightly icons with the Tick3d lightning icon from `assets/fork/tick3d-macos.svg`. The desktop app, its notifications and the bundled web page use these files. The Android APK uses the layers `assets/fork/tick3d-android-{foreground,background,monochrome}.svg`, as PNG files in `apps/mobile/assets/fork/`. `apps/mobile/src/lib/forkAndroidIcon.ts` applies them when `T3CODE_ANDROID_PACKAGE` is set, which only `scripts/fork-android-apk.sh` does. To change the icon, edit the SVG and run:

```sh
S=assets/fork/tick3d-macos.svg N=assets/nightly T=$(mktemp -d)
rsvg-convert -w 1024 -h 1024 $S -o $N/nightly-macos-1024.png && cp $N/nightly-macos-1024.png $N/nightly-universal-1024.png
rsvg-convert -w 180 -h 180 $S -o $N/nightly-web-apple-touch-180.png
for s in 16 32; do rsvg-convert -w $s -h $s $S -o $N/nightly-web-favicon-${s}x${s}.png; done
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s -h $s $S -o $T/$s.png; done
magick $T/{16,24,32,48,64,128,256}.png $N/nightly-windows.ico && cp $N/nightly-windows.ico $N/nightly-web-favicon.ico
```

## macOS signing

The fork signs with the self-made certificate "Yarden Zamir T3 Fork". The fork does not notarize. Squirrel.Mac installs an update only when the update has the same signature as the running app, so every build must use the same certificate.

- The certificate, the key and the `.p12` password are in `_shared/signing/` in the repository container. They are not in git.
- The repository secrets `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD` hold the same certificate.
- `T3CODE_DESKTOP_MAC_SELF_SIGNED=true` tells `scripts/build-desktop-artifact.ts` to skip the passkey entitlements. Passkeys need an Apple team.
- The first install of a fork build is manual, because the upstream Nightly has another signature. macOS blocks the first start of an app that is not notarized. To allow it, Control-click the app and select Open.

### Trust the certificate on your Mac

Do this one time before the first local build:

```sh
security import _shared/signing/cert.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -P "$(cat _shared/signing/p12-password.txt)"
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db _shared/signing/cert.pem
security find-identity -v -p codesigning
```

The last command must list "Yarden Zamir T3 Fork".

## Local Mac build

A local build is the fast way to test a change on this Mac. It does not replace the normal flow: merge the change to main, and its CI release reaches every machine.

| Command                                 | Result                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scripts/fork-desktop-mac.sh`           | Writes the signed ZIP and `nightly-mac.yml` to `release/`. It skips the DMG, which only a first manual install uses.          |
| `scripts/fork-desktop-mac.sh --install` | Quits T3, keeps the previous app in `_shared/backup/`, installs the new build and starts it. The next CI release replaces it. |
| `scripts/fork-desktop-mac.sh --publish` | Push the commit first. Creates a prerelease on the fork. Installed fork apps offer it as an update.                           |

## Server updates

A headless server that runs as the upstream background service (`t3 service install`) updates from the fork releases. The install is the upstream self-update. It unpacks the release into `<T3 home>/runtime/versions/<version>`, and the service launcher starts it on trial. If the new version does not start, the launcher goes back to the old version.

- The user setting is [Server auto-update](features.md#server-auto-update). It checks the fork releases every 5 minutes.
- A release is ready when it has `SHA256SUMS`. A version that rolled back or failed is not tried again. A newer release is tried.
- The machine map command `installUpdate` works on such a server too (MM-505). `whenIdle: false` installs the newest fork release now. `whenIdle: true` installs it at the first check with no running agent turn or background shell, also when `forkAutoUpdate` is off.
- A restart stops the running turns. "Continue threads after restarts" (`continueThreadsAfterServerUpdate`) and [Recover interrupted agents](features.md#recover-interrupted-agents) continue them.
- "Update everything" and `t3 update` also install fork releases. A self-update request for a version without a fork release installs the newest fork release instead. The Play Store app checks upstream releases, so its "Check for updates" installs the newest fork release.

## Deploy a local build

To try a change on a headless server before a release, deploy a build of your checkout over SSH. The server must run as the background service.

```sh
scripts/fork-deploy-local.sh <ssh-host>
```

- The script reads the system of the server with `ssh <ssh-host> uname -sm`. It supports Linux x64 and arm64.
- It builds the web client and the `t3` executable here. It takes the native packages and the resource monitor from the newest fork release that has `SHA256SUMS`.
- If the checkout changes `apps/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` or `patches` since that release, the script stops. Such a change needs a release.
- The version follows the rule of the local Mac build in [Versions](#versions), so `forkAutoUpdate` replaces it with the next release.
- On the server, the script unpacks the build into `<T3 home>/runtime/versions/<version>` and runs `t3 update <version> --yes`. The service restarts at once, and the restart stops running agent turns.
- After the switch, the script waits up to 90 seconds until `/.well-known/t3/environment` of the server reports the new version. If it does not, the script runs `t3 update <previous version> --yes --allow-downgrade` on the server and fails. If that rollback fails, it prints the command to run on the server. The earlier version is still in `runtime/versions`.
- `<T3 home>` is `~/.t3` of the SSH user, or `T3CODE_HOME` of the SSH session.
- To build only, run `scripts/fork-deploy-local.sh --archive linux-x64` or `--archive linux-arm64`. The archive is in `release/`.

## Install the fork

`scripts/fork-install/` installs the fork on a new machine and joins the machine map. The join dialog of the portal shows these commands with the join code (MM-211).

```sh
curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash -s -- --join <code>
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1))) -Join <code>
```

- On macOS, `install.sh` downloads the newest nightly `.dmg`, copies the app to `/Applications` and opens it.
- On Windows, `install.ps1` downloads and runs the newest nightly `.exe`.
- On Linux with a display (`DISPLAY` or `WAYLAND_DISPLAY`), `install.sh` downloads the newest nightly AppImage to `~/Applications/T3-Code.AppImage`, adds a menu entry and starts it. AppImages need FUSE 2, for example `sudo apt install libfuse2t64`.
- The macOS and Linux desktop installs keep an installed app, because the app updates itself. `--force` replaces it.
- With a join code, a desktop install writes the code to `~/.t3/userdata/machine-map-join-code` (or below `T3CODE_HOME`). The app server joins with it at its next start and deletes it. If the app was open, quit it and open it again. The code expires after 10 minutes.
- On Linux without a display, `install.sh` runs `scripts/install.sh`, the upstream installer pointed at the fork releases. It unpacks the newest release into `~/.t3/runtime/versions/<version>` and links `~/.local/bin/t3` to it. Then it runs `t3 service install` and `t3 machine-map join <code>`. The machine needs no Node.
- The drop-in file `~/.config/systemd/user/t3code.service.d/fork.conf` keeps the headless server on `127.0.0.1:3773` with the PATH of the installer shell.
- `t3 service install` turns on lingering, so the server keeps running after logout. If that needs an administrator, it says so. See [background-service.md](../user/background-service.md#troubleshooting).
- The installers read the release list of the GitHub API, because the nightlies are prereleases and `releases/latest` skips them.
- Run `install.sh --help` for the options.

### Set up a headless Linux machine

These steps set up a Linux server without a display, for example an Oracle Cloud Ubuntu 24.04 machine on Ampere (arm64). Run them over SSH as the normal user, for example `ubuntu`. Do not run the installer with `sudo` or `su`, because the server runs as a systemd user service.

1. In the portal, click "Add machine". The join dialog shows the Linux command with the join code.
2. On the machine, run that command:

   ```sh
   sudo apt-get update && sudo apt-get install -y curl tar ca-certificates libatomic1
   curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash -s -- --join <code>
   ```

3. Wait until the join dialog shows that the machine joined.

The portal makes the tunnel `t3-<name>.yarden-zamir.com` for the machine (MM-213). The server saves it, restarts once and runs the pinned `cloudflared` from `~/.t3/tools/cloudflared/` as a child process (MM-1309).

- If the join code expired, make a new code in the machine panel of the portal.
- The tunnel connects outbound, and the server listens only on `127.0.0.1`, so the cloud firewall needs no change. On Oracle Cloud, keep the default security list and the `iptables` rules of the image.
- To check the server, run `t3 service status` and `systemctl --user status t3code.service`. The `cloudflared` log is `~/.t3/userdata/logs/cloudflared.log`.
- To update the server by hand, run `t3 update`. See [Server updates](#server-updates).

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

## Android APK build

`.github/workflows/fork-android.yml` ("Fork Android") adds `t3code-<version>-android.apk` to the release after each successful Fork Release of main. It is a local Gradle build with `scripts/fork-android-apk.sh`, so the fork needs no Expo or Google Play account. How users install it: [Android APK](features.md#android-apk).

- It runs outside the Fork Release concurrency group, so the slow Gradle build never delays the next release. A newer run cancels an older one.
- It builds only when the app changed since the newest earlier release with an APK: `apps/mobile/`, `packages/`, `pnpm-lock.yaml`, `patches/`, `scripts/fork-android-apk.sh` or the workflow. Otherwise it skips and names that release in a notice. A skipped release cancels no build.
- To force a build for a release, run Fork Android by hand on main with the input `release_tag`, for example `gh workflow run fork-android.yml -R Yarden-zamir/t3code --ref main -f release_tag=<tag>`.
- It only uploads to an existing release, and never creates one. A failure marks only Fork Android and does not call the repair agent. A run from a branch uploads the APK as a workflow artifact.
- The APK is the nightly ("Preview") app with the package `com.yardenzamir.t3code`. It holds arm64 code only.
- The version name is the fork release version. The version code is the commit time in minutes since 2026-01-01, so it only grows along main.
- The fork key in `_shared/android-signing/` signs every APK. The repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` hold the same key. Only the signing step sees them. Android refuses an update with another key, so do not replace the key.
- The Obtainium link in the portal "Invite an app" dialog is in `apps/machine-map/src/ui/obtainium.ts`.
- Upstream's mobile workflows need Expo, Google Play or Blacksmith runners. They are disabled on the fork. After a sync that adds a `mobile-*` workflow, disable it with `gh workflow disable "<name>" -R Yarden-zamir/t3code`.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate. See [macOS signing](#macos-signing).                                                                                                                           |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`             | secret             | Android signing key. See [Android APK build](#android-apk-build).                                                                                                                         |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `T3_AGENT_WEBHOOK_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`                | secret, optional   | Webhook URL of the repair agent task, and the Cloudflare Access service token that the call needs. Without the URL, no agent is notified.                                                 |
| `CLOUDFLARE_DEPLOY_TOKEN`                                                               | secret             | Deploy of the machine map portal. See [apps/machine-map/README.md](../../apps/machine-map/README.md#deploy).                                                                              |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
