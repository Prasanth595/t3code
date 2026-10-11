# Fork releases

This fork ([Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code)) publishes its own desktop builds.
The installed app updates itself from the fork releases through the built-in updater.

## How it works

Fork main only moves forward. Nothing rebases or force-pushes it.

- `.github/workflows/fork-sync.yml` merges `pingdotgg/t3code` main into fork main every day. It typechecks the merge and pushes it as a fast-forward. If main moved during the run, it merges the new main and pushes again.
- If the merge conflicts or the typecheck fails, the sync comments on the issue "Fork sync: upstream merge failed" and stops.
- `.github/workflows/fork-release.yml` builds the desktop apps. It runs when a push to main changes the app shell (`apps/desktop`, icons, build config, dependencies), once a day, and on manual dispatch. If the commit already has a release, it stops early. Server and web changes reach the machines without a release, see "Live server updates" and "Deploy to the VPS".
- The release builds macOS arm64 (signed) and Windows x64 (unsigned) at the same time. Each platform publishes to the release when its build is done, so the Mac does not wait for Windows.
- The release carries `nightly-mac.yml` and `nightly.yml` for electron-updater. Until the Windows build adds `nightly.yml`, Windows apps find no update in the new release.
- If a sync or a release fails, its `notify_agent` job runs `scripts/fork-notify-agent.sh`. The script posts the run to `T3_AGENT_WEBHOOK_URL`, a webhook scheduled task on a T3 server that starts a repair agent. A manual run with `notify_agent=false` does not post. A failure right after a failure of the same workflow does not post either, because the agent that the first failure started watches the next run.
- `.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners for each push to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled on the fork.
- To see all fork changes, run `git diff upstream/main...main`.

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

## Live server updates

Most fork changes are server and web code. They reach the Mac without a new app and without an app restart.

- The setting `T3CODE_DESKTOP_LIVE_SERVER_DIR` names a live server folder. It is off when unset.
- With the setting, the app runs its server and web client from `<folder>/current` instead of from the app bundle. `current` is a link to `<folder>/a` or `<folder>/b`, two worktrees of this repository.
- `scripts/fork-live/build.sh` runs every minute. When fork main has a new commit, it builds it in the folder that `current` does not point to. Then it writes `<folder>/ready.json` with the path, commit, subject and build time.
- The update button offers the ready build as `live <commit>`. A full app update always comes first.
- Install moves the `current` link, restarts the server and reloads the windows. If the new server does not start, the link goes back and the previous server starts again.
- A failed build shows a macOS notification. The app keeps its current server.
- A full app update is still needed when the app shell changes: `apps/desktop`, Electron or the native dependencies.

One-time setup on the Mac:

```sh
export T3CODE_DESKTOP_LIVE_SERVER_DIR="$HOME/Github/t3code/live"
scripts/fork-live/build.sh
"$T3CODE_DESKTOP_LIVE_SERVER_DIR/current/scripts/fork-live/install-agent.sh" "$T3CODE_DESKTOP_LIVE_SERVER_DIR"
```

The first build creates `current` and sets the setting for apps that start later. Then quit and start the app once. The build log is `~/Library/Logs/t3-live-build.log`.

## Deploy to the VPS

The VPS server follows fork main. The timer `t3-deploy.timer` runs `scripts/fork-vps/deploy.sh` one minute after each run ends.

- When main has a new commit, the script builds it while the old server keeps running. It builds each commit once.
- It switches only when no agent turn runs. A server restart cancels running turns, and T3 does not resume them. While agents run, the next run tries again.
- `/opt/t3code` is a link to `/opt/t3code-a` or `/opt/t3code-b`. The script builds in the other folder, moves the link and restarts `t3-server`.
- If the new server does not answer, the script moves the link back.

One-time setup, as root on the VPS:

```sh
systemctl stop t3-server && mv /opt/t3code /opt/t3code-a && ln -s /opt/t3code-a /opt/t3code && systemctl start t3-server
git -C /opt/t3code-a worktree add --detach /opt/t3code-b HEAD
cp /opt/t3code/scripts/fork-vps/t3-deploy.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now t3-deploy.timer
```

To read the result, run `journalctl -u t3-deploy.service -n 50`.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate.                                                                                                                                                                |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `T3_AGENT_WEBHOOK_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`                | secret, optional   | Webhook URL of the repair agent task, and the Cloudflare Access service token that the call needs. Without the URL, no agent is notified.                                                 |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
