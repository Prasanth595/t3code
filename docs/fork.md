# Fork releases

This fork ([Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code)) publishes its own desktop builds.
The installed app updates itself from the fork releases through the built-in updater.
Agents that operate the machines, the machine map or the deploys start with [fork-agents.md](fork-agents.md).

## How it works

Fork main only moves forward. Nothing rebases or force-pushes it.

- `.github/workflows/fork-sync.yml` merges `pingdotgg/t3code` main into fork main every day. It typechecks the merge, runs the fork tests and pushes it as a fast-forward. The fork tests are the test files that the fork changed since the last merged upstream commit, `git merge-base upstream/main HEAD`. A diff against a newer upstream main also lists files that only upstream changed. If main moved during the run, it merges the new main and pushes again.
- If the merge conflicts, the typecheck fails or a fork test fails, the sync comments on the issue "Fork sync: upstream merge failed" and stops.
- `.github/workflows/fork-release.yml` builds the desktop apps. It runs when a push to main changes the app shell (`apps/desktop` without its tests, icons, build config, dependencies, or the settings schema `packages/contracts/src/settings.ts`, because the shell drops client settings it does not know), once a day, and on manual dispatch. If the commit already has a release, it stops early. Server and web changes reach the machines without a release, see "Live server updates" and "Deploy to the VPS".
- The release builds macOS arm64 (signed) and Windows x64 (unsigned) at the same time. Each platform publishes to the release when its build is done, so the Mac does not wait for Windows.
- The release carries `nightly-mac.yml` and `nightly.yml` for electron-updater. Until the Windows build adds `nightly.yml`, Windows apps find no update in the new release.
- If a sync, a release or a Fork CI run fails, its `notify_agent` job runs `scripts/fork-notify-agent.sh`. The script posts the run to `T3_AGENT_WEBHOOK_URL`, a webhook scheduled task on a T3 server that starts a repair agent. A manual run with `notify_agent=false` does not post. A failure right after a failure of the same workflow does not post either, because the agent that the first failure started watches the next run.
- `.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners for each push to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled on the fork.
- A newer push to main cancels the Fork CI run of the older push. The repair agent ignores a cancelled run.
- Fork CI compares the push with the commit of the last green run. When only `docs`, `*.md` or `apps/machine-map` changed, only the Lint job runs, and it checks only the changed files. A change in `apps/machine-map` also runs the Machine map job: its typecheck and tests. A manual run always runs every job.
- To see all fork changes, run `git diff upstream/main...main`.
- The top of `README.md` lists the fork features and fixes, up to the first `---` line. A pull request that adds, removes or changes a fork feature or fix updates its line in that list.
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

## Live server updates

Most fork changes are server and web code. They reach the Mac without a new app and without an app restart.

- The setting `T3CODE_DESKTOP_LIVE_SERVER_DIR` names a live server folder. It is off when unset.
- With the setting, the app runs its server and web client from `<folder>/current` instead of from the app bundle. `current` is a link to `<folder>/a`, `<folder>/b` or `<folder>/c`, three worktrees of this repository.
- `scripts/fork-live/build.sh` runs every minute, from the copy `<folder>/build.sh`. Each successful build replaces that copy, so a builder fix applies at once. When fork main has a new commit, it builds it in the folder that neither runs nor is on offer. Then it writes `<folder>/ready.json` with the path, commit, subject and build time. Thus a build on offer stays complete until you install it or a newer build replaces it.
- When the new commits change only paths that do not reach the server or web bundle, the script builds nothing. It writes the commit to `<folder>/no-build-sha`, so that it does not try the commit again. These paths are `docs`, `*.md`, `.github`, `apps/desktop`, `apps/mobile`, `apps/marketing`, `apps/machine-map` and test files.
- The install covers only the packages that the `t3` build needs, not the mobile app. When the lockfile, the workspace file, the patches and the package manifests did not change since the last install of the build folder, the script skips the install.
- When the new commits change only `apps/server` without its `package.json`, the script copies the web bundle of the newest build and builds only the server.
- The build log has a timestamp and a duration for each phase.
- The update button offers the ready build as `live <commit>`. A full app update always comes first. The upstream "update everything" pass comes after the live build, and other servers do not follow a live build.
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

## Changelog

The client setting `forkChangelogEnabled` turns on a changelog of the fork. It is off by default. Turn it on in Settings > General > About > Fork changelog.

- Open it from the Fork changelog row in Settings, or from "Open changelog" in the update button popover on the desktop app. It opens also when no update is available.
- The Releases tab is one timeline of commits, newest first. A thin divider shows each release, its time and an "Installed" mark. The commits that the release adds to the release before it follow the divider.
- The timeline shows 10 releases first. "Show older releases" adds 10 more, because each release costs GitHub requests.
- Each commit shows as its own row. A fork commit has a "Fork" mark, and an upstream commit has no mark. A range of more than 500 commits stops at 500 with a note.
- Each commit, release and Fork Sync run shows its time and the time since, for example "9:41 AM, 12th October 2026 · 3h ago". The time since updates once a minute while the changelog is open.
- The release version, commit sha, author, run and each job link to GitHub. A `#123` in a fork commit subject links to the fork pull request. In an upstream commit subject, it links to the upstream pull request.
- A fork commit is a commit that `pingdotgg/t3code` main does not contain. Merge commits do not show.
- The Upstream tab lists the upstream main commits that fork main does not have yet, in the same rows. Its "Start Fork Sync" button starts `.github/workflows/fork-sync.yml` and shows the run and each job. The tab reads the run again every 5 seconds while the run is queued or running.
- The "Ask agent" menu opens a thread in the fork project of the same machine, like "Ask a question" on a pull request. The composer gets a changelog chip and a prompt to read and send. The Releases tab offers "Ask a question", "Summarize the changelog" and, when a newer release exists, "What changed since my version". The Upstream tab offers "Ask a question" and, when upstream commits wait, "Summarize upstream changes" and "Check the impact on the fork".
- The fork project is the first project whose repository is `Yarden-zamir/t3code`, either as the only remote or as `origin` beside an `upstream` remote. Without one, the menu shows an error.
- The server reads GitHub with the GitHub credential of its machine, the same one that pull requests use (settings, `GH_TOKEN` or `gh auth login`). Without a credential, the changelog shows the GitHub error.
- Starting Fork Sync needs the `source-control:write` scope on the connection.

## Deploy to the VPS

The VPS server follows fork main. The timer `t3-deploy.timer` runs `scripts/fork-vps/deploy.sh` one minute after each run ends.

- When the new commits change only paths that do not reach the server build, the script moves the running checkout to the new commit without a build or a restart. These paths are `docs`, `*.md`, `.github`, `apps/desktop`, `apps/mobile`, `apps/marketing` and test files.
- Otherwise it waits until main has not moved for 10 minutes, so a burst of merges gets one build. Then it builds main while the old server keeps running. It builds each commit once.
- It switches only when no agent turn runs. A server restart cancels running turns. T3 resumes them only when "Recover interrupted agents" or "Continue threads after restarts" is on. While agents run, it checks again after 5 minutes, because each check starts one node process per project.
- `t3-deploy.service` runs at a low CPU, IO and process priority. Above 6 GB of memory, the kernel slows the build instead of taking memory from the other apps on the VPS.
- `/opt/t3code` is a link to `/opt/t3code-a` or `/opt/t3code-b`. The script builds in the other folder, moves the link and restarts `t3-server`.
- If the new server does not answer, the script moves the link back.

One-time setup, as root on the VPS:

```sh
systemctl stop t3-server && mv /opt/t3code /opt/t3code-a && ln -s /opt/t3code-a /opt/t3code && systemctl start t3-server
git -C /opt/t3code-a worktree add --detach /opt/t3code-b HEAD
cp /opt/t3code/scripts/fork-vps/t3-deploy.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now t3-deploy.timer
```

A change to `t3-deploy.service` or `t3-deploy.timer` reaches the VPS only when you run the `cp` and `systemctl daemon-reload` again.

To read the result, run `journalctl -u t3-deploy.service -n 50`.

## Recover interrupted agents

Every agent runs as a child process of the T3 server. An update, a crash or a quit stops them all. When the setting is on, the next server start sends each stopped thread a short message, so that its agent continues.

- Turn it on in Settings > General > Recover interrupted agents. It is off by default.
- The server settings keys are `recoverInterruptedTurns` (default `false`), `recoverInterruptedTurnsMessage` (default "Recover and continue") and `recoverInterruptedTurnsSubagentMessage` (default "Recover and continue. Your parent thread was also restarted."). They are in `settings.json` in the T3 home `userdata` folder, for example `~/.t3/userdata/settings.json`.
- It extends the upstream setting "Continue threads after restarts" (`continueThreadsAfterServerUpdate`). When the fork setting is on, it replaces the upstream behavior on every project, with the configured messages.
- A thread gets the message when the restart stopped its turn, or when its turn was finished but background work of that turn was still open. Background work is a native subagent, a monitor or a background shell.
- A native subagent, for example a Claude Code Task subagent, lives inside the process of its parent agent. It is not a T3 thread and gets no message. The message to its parent thread covers it, together with a note that names the stopped work.
- A thread that another thread delegated work to gets the delegated thread message.
- No message goes to a thread that the user stopped, snoozed or settled, to a turn that ended on its own, to a turn that waited for an answer, an approval or a secret, to a turn that did not start, to a thread without a saved provider session, or to a thread with newer work. Held queued messages stay held.
- Each stopped turn gets one message at most. A recovery turn that a restart stops before it answers gets no second message, so a restart loop does not repeat it.
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

The client setting `repositoryOwnerFilters` filters lists by the owner of each repository: a GitHub account or organization. It is off by default. Turn it on in Settings > General > Repository owner filters.

- The owner comes from the repository that groups the project in the sidebar. A fork checkout counts under the owner of the fork.
- Pull request page: open Filters > Owner. Pick "Show only selected" or "Hide selected", then pick the owners.
- In the pull request search, type `org:` or `owner:` to show only an owner, and `-org:` or `-owner:` to hide an owner. A typed owner replaces the menu choice.
- Sidebar: click the building icon next to the project scope, pick "Show only" or "Hide", then pick the owners.
- While the sidebar filter is on, a chip under the header names it and counts the hidden projects. Click "is" or "is not" on the chip to flip it. Click × to clear it.
- The sidebar keeps a thread visible while it runs, waits for its subagents or monitors, or waits for you. This also applies when the filter hides its project.
- A project without a remote has no owner. "Show only" hides it, and "Hide" keeps it. In the sidebar, pick "No repository owner" to filter these projects.

## Pull request filter chips

The client setting `pullRequestFilterChips` shows the active pull request filters as chips above the list. It is off by default. Turn it on in Settings > General > Pull request filter chips.

- Each filter that the Filters menu, the provider menu or the project scope sets gets a chip, for example "State: Merged" or "Owner is not qlik-trial".
- Click "is" or "is not" on a chip to flip it. Owners, drafts and labels can flip. A label flips into a typed `-label:`, because the menu cannot exclude labels.
- Click × on a chip to remove that filter. Click "Clear all" to remove all of them.
- Typed qualifiers stay in the search box, so they get no chip. A menu filter that a typed qualifier replaces gets no chip, because it does not apply.
- When no pull request matches the menu filters, the empty list names them and offers "Clear filters". With search text, the empty list names the search instead.

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

## Machine map

The server setting `machineMap` connects this server to the machine map portal. It is off by default. The requirements are in `apps/machine-map/SPEC.md`, and the portal setup is in `apps/machine-map/README.md`.

- Agents use the machine map through the `machines_*` and `machine_tool_call` tools. See [fork-agents.md](fork-agents.md).
- Join: in the portal, "Add machine" shows a one-time join code. On the machine, enter it in Settings > Machines, run `t3 machine-map join <code>`, or ask an agent to use the `machines_join` tool. The join saves the machine token in the server secret store and turns `machineMap` on.
- Settings > Machines shows the connection status, the last error, the portal link, this machine's name, and the machines that it can use with their levels. "Leave" forgets the token and turns `machineMap` off. Join and leave need the `settings:write` scope.
- The server keeps one outbound WebSocket to the portal. It applies its desired state (settings and arrows) live, and saves it, so a restart applies it before other machines can connect.
- The desktop app reads the machine map state of its own server. It acts only while that server is joined, because only then does the server send it the token headers.
  - It saves one environment for each machine that it can use, with the machine token as request headers for that origin only, and pairs it through `/api/auth/cloudflare-access/pairing-credential`. When the machine leaves the list, the app removes the environment and its headers. It pairs again once when the target ends the session after a level change. Environments that the user saved by hand stay as they are.
  - It applies the desired client settings and reports its current client settings. The server leaves out values that equal the desired ones, so the map does not see its own writes as local changes.
  - It runs `reloadWindows` and `installUpdate` and reports each result before it acts. `installUpdate` with "when idle" uses the install-when-idle wait. It also reports the version of a waiting update.
- Another machine signs in with its Cloudflare Access service token. The server gives it the scopes of the arrow from that machine, with the session subject `machine:<id>`. A level change ends that machine's sessions at once.
- Deploy the portal: `.github/workflows/fork-machine-map-deploy.yml` tests and deploys it from main when `apps/machine-map` or its contracts change, with the GitHub secret `CLOUDFLARE_DEPLOY_TOKEN` (Workers Scripts and Workers Routes edit). Do not deploy by hand: a deploy from a branch rolls back main. The Worker needs the secrets `SECRET_KEY` and `CF_API_TOKEN`.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate.                                                                                                                                                                |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `T3_AGENT_WEBHOOK_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`                | secret, optional   | Webhook URL of the repair agent task, and the Cloudflare Access service token that the call needs. Without the URL, no agent is notified.                                                 |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
