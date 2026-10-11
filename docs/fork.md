# Fork releases

This fork ([Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code)) publishes its own desktop builds.
The installed app updates itself from the fork releases through the built-in updater.

## How it works

- `.github/workflows/fork-release.yml` runs on each push to main, every day for upstream changes, and on manual dispatch. One run runs at a time.
- The workflow rebases the branch onto `pingdotgg/t3code` main and keeps the fork commits on top.
- If the rebase or the typecheck fails, the workflow comments on the issue "Fork release: upstream sync failed" and stops.
- If any job fails, the `notify_agent` job posts the run to `T3_AGENT_WEBHOOK_URL`. That URL is a webhook scheduled task on a T3 server, which starts a repair agent. A manual run with `notify_agent=false` does not post. The agent uses that input on its own retries, so a failed retry does not start a loop.
- Otherwise it pushes the branch. If main moved during the run, it rebases the new main and pushes again.
- If the commit already has a release, the run stops there. The sync push itself starts such a run.
- It builds macOS arm64 (signed) and Windows x64 (unsigned) at the same time. Each platform publishes to the release when its build is done. The Mac release does not wait for Windows, and a Windows failure does not block it.
- The release carries `nightly-mac.yml` and `nightly.yml` for electron-updater. Until the Windows build adds `nightly.yml`, Windows apps find no update in the new release.
- `.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners for each push to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled on the fork.

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
CI uses the workflow run number as the build number. A local build adds the time to the newest CI run number: `<UTC date>.<run number>.<HHMMSS>`, for example `0.0.46-nightly.20261011.14.161502`. Thus a local build is newer than the CI release it follows, and older than the next CI release.

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

## Deploy to the VPS

The VPS server runs the newest CI release. The timer `t3-deploy.timer` runs `scripts/fork-vps/deploy.sh` every hour.

- The script deploys at most once per UTC day.
- It deploys only when no agent turn runs. A server restart cancels running turns, and T3 does not resume them.
- `/opt/t3code` is a link to `/opt/t3code-a` or `/opt/t3code-b`. The script builds in the other folder, moves the link and restarts `t3-server`.
- If the new server does not answer, the script moves the link back.

One-time setup, as root on the VPS:

```sh
systemctl stop t3-server && mv /opt/t3code /opt/t3code-a && ln -s /opt/t3code-a /opt/t3code && systemctl start t3-server
git -C /opt/t3code-a worktree add --detach /opt/t3code-b HEAD
cp /opt/t3code/scripts/fork-vps/t3-deploy.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now t3-deploy.timer
```

To deploy now, run `systemctl start t3-deploy.service`. To read the result, run `journalctl -u t3-deploy.service -n 50`.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate.                                                                                                                                                                |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `T3_AGENT_WEBHOOK_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`                | secret, optional   | Webhook URL of the repair agent task, and the Cloudflare Access service token that the call needs. Without the URL, no agent is notified.                                                 |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
