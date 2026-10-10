# Fork releases

This fork ([Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code)) publishes its own desktop builds.
The installed app updates itself from the fork releases through the built-in updater.

## How it works

- `.github/workflows/fork-release.yml` runs every day and on manual dispatch.
- The workflow rebases the branch onto `pingdotgg/t3code` main and keeps the fork commits on top.
- If the rebase or the typecheck fails, the workflow comments on the issue "Fork release: upstream sync failed" and stops.
- Otherwise it pushes the branch and builds macOS arm64 (signed) and Windows x64 (unsigned).
- It publishes a GitHub prerelease with `nightly-mac.yml` and `nightly.yml` for electron-updater.
- `.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners for each push to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled on the fork.

The builds use the `nightly` update channel, the app id `com.t3tools.t3code` and the data directory `~/.t3`.
They replace the upstream Nightly app and keep its data.

## App icon

The fork replaces `assets/nightly/nightly-macos-1024.png` with the Tick3d icon. The source is `assets/fork/tick3d-macos.svg`. To change it, edit the SVG and run `rsvg-convert -w 1024 -h 1024 assets/fork/tick3d-macos.svg -o assets/nightly/nightly-macos-1024.png`.

## Versions

The version is `<upstream base version>-nightly.<UTC date>.<build number>`, for example `0.0.46-nightly.20261010.3`.
CI uses the workflow run number as the build number. Local builds use `1HHMMSS`.

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

```sh
scripts/fork-desktop-mac.sh --install
```

The script quits T3, keeps the previous app in `_shared/backup/`, installs the new build and starts it. GitHub is not involved.
The fork updater never downgrades, so the local build stays until a newer release exists.

## Publish a local build

Push the commit first. Then run:

```sh
scripts/fork-desktop-mac.sh --publish
```

The script creates a prerelease on the fork. Installed fork apps offer it as an update.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate.                                                                                                                                                                |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
