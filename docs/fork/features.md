# Fork features

The user-facing features of the fork [Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code). The groups follow the README list and Settings > Fork. Settings > Fork shows every fork setting, with the same rows as their usual pages. Maintainer procedures are in [operations.md](operations.md).

Each section names:

- **Setting:** the settings key, its default and its place in Settings. A server setting applies to every client of that environment. A client setting applies to one browser or device.
- **Works on:** web, desktop and mobile. "Server" means that the server does it for every client.
- **Limits:** known limits, each with the condition to revisit it.

## Remote access

### Cloudflare Access login

The server accepts the Cloudflare Access JWT as the owner login, so a browser behind Cloudflare Access needs no pairing link.

- **Setting:** `cloudflareAccessTeamDomain`, `cloudflareAccessAud` and `cloudflareAccessSubjects` (empty by default). On the desktop app, set them in Settings > Connections, under "Allow pairing through a tunnel". On a headless server, set `T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `T3CODE_CLOUDFLARE_ACCESS_AUD` and `T3CODE_CLOUDFLARE_ACCESS_SUBJECTS`.
- **Works on:** server. The mobile app signs in with a Cloudflare Access service token, see [Request headers per environment](#request-headers-per-environment).
- **Limits:** the subjects list must hold the client id of the service token that the desktop app uses for remote machines. Without it, the desktop app cannot open the machine. Revisit when that service token is retired.

### Request headers per environment

A saved environment sends its own request headers, for example a Cloudflare Access service token.

- **Setting:** per saved environment. On desktop, edit them in Settings > Connections. On mobile, enter the token under "Cloudflare Access service token" in Add environment, or in the settings of the environment.
- **Works on:** desktop, mobile. The mobile app sends the headers on API requests, the WebSocket, attachment uploads and downloads, the attachment text preview, and project, attachment and Markdown images (also SVG).
- **Limits:** the mobile app does not send them for provider icons, the media gallery, audio and video, thread link previews and web views. Web views cannot limit their sub-requests and redirects to one origin. Revisit when a missing request type blocks a real use.

### Tunnel pairing

A desktop server that listens on loopback makes pairing links with its tunnel URL.

- **Setting:** `tunnelPairingEnabled` (off by default) and `tunnelPairingUrl`. Settings > Connections > "Allow pairing through a tunnel", in the desktop app of the local server. On a headless server, set `T3CODE_TUNNEL_PAIRING_URL`.
- **Works on:** desktop (the setting). Every client can open the pairing link.

### Trusted sibling environments

Trusted browser origins get credentialed CORS and session cookies. One browser page then pairs with and reaches the other hosts.

- **Setting:** `trustedBrowserOrigins` (empty by default). Settings > Connections > "Allow pairing through a tunnel", in the desktop app. On a headless server, set `T3CODE_TRUSTED_BROWSER_ORIGINS`. A server on the machine map trusts the origins of the other machines without this setting (MM-1311).
- **Works on:** web, desktop. Mobile does not need it.

## Machine map

One portal at `https://t3.yarden-zamir.com` (a Cloudflare Worker) maps every T3 machine and sets what each machine can do on the others.

- **Setting:** `machineMap` (off by default). A join turns it on. Settings > Machines.
- **Works on:** server and desktop. The portal is a web app that also works in a phone browser. The mobile app joins through [app invites](#app-invites-and-app-tokens), but has no Settings > Machines and no Machines panel.
- **Reference:** the requirements are in [apps/machine-map/SPEC.md](../../apps/machine-map/SPEC.md) (MM-xxx). Portal setup, client access steps and sync details are in [apps/machine-map/README.md](../../apps/machine-map/README.md). Agents use [fork-agents.md](../fork-agents.md).

### Portal views

The portal has the views Map, Table, Health, Settings, Queue, Tasks, History, Inbox and Clients (MM-1102). Each view and each selected item has its own link. Agents use the `machines_*` and `machine_tool_call` tools for machine operations. Client approvals, invites and the resume after an emergency pause stay with the owner.

### Join and install

In the portal, "Add machine" shows a one-time join code and one install command per system. The command installs the fork and joins the map, see [Install the fork](operations.md#install-the-fork). On a machine that runs the fork, enter the code in Settings > Machines, or run `t3 machine-map join <code>`. The portal makes the tunnel of the machine when it can (MM-213).

- The open join dialog shows when a machine uses the code, and whether it connected.
- The code expires after 10 minutes.

### Settings > Machines

Settings > Machines joins or leaves the map with a code. It shows the connection status, the last error, the portal link, the name of this machine, and the machines that this machine can use with their levels. Join and leave need the `settings:write` scope. Only the desktop app of a machine joins, leaves and changes "Client access" (MM-919).

### Desktop app on the map

The desktop app adds each machine that its server can use as an environment, with the machine token headers, and removes it when the arrow drops to `none` (MM-1401). It applies the shared client settings, and runs the commands Reload windows and Install update (MM-1402). Environments that you saved by hand stay as they are.

When a machine refuses the connection, the app pairs again with a backoff: at least 30 seconds between two pairings of one machine, and up to 10 minutes after repeated failures. The target gives a machine its live session again, so a new pairing adds no session (MM-1305). Machine, client and Cloudflare Access sessions without a connection for 7 days end. The Clients view shows one row for each machine, client or sign-in on a machine (MM-903).

### Settings and theme sync

A setting with a shared value syncs to every machine, also to an offline or a new machine (MM-406). In T3 Settings, a change with "All environments" selected sets the shared value, when the machine has the map role `edit` (MM-411). A change for one environment becomes the own value of that machine. A synced row shows a sync marker.

- Custom themes (the `themes/` folder, as `sharedThemes`) and `defaultTheme` sync too (MM-408 to MM-410).
- Keybindings sync while `keybindingSync` is on (off by default). Settings > Keybindings > Machine map > "Sync keybindings". The shared value replaces the whole `keybindings.json` of each machine, and the machine keeps the file before it as `keybindings.json.bak`. Details: [Keybinding sync](../../apps/machine-map/README.md#keybinding-sync).
- Paths, secrets, project-keyed maps and the map connection stay on each machine.

### Zoom and pan

The map has no edges. Cards stay where you drop them. The map zooms, pans and fits all cards, also on phones and small windows. "Auto layout" places every card so that the map reads well, as one change with Undo.

### Approved clients

Clients are the browsers and phones of the owner (MM-904). A new browser waits in the Clients view until the owner approves it with a fresh MFA step. Each client gets a card and a level per machine.

### Client access

Each machine decides which browsers get in through Cloudflare Access.

- **Setting:** `clientAccess` (`off` by default). Change it per machine in the portal Settings view, with the passkey step. In the desktop app of a machine, change it in Settings > Machines > "Client access".
- `off` keeps the owner login. `observe` gives a browser of an approved client the level of its arrow, at most `standard`. `enforce` lets in only browsers of approved clients. Other browsers wait for approval.
- To turn it on safely, and to get back in after a lockout, follow [Client access](../../apps/machine-map/README.md#client-access) in the portal README.

### Sibling client sessions

A browser client session lasts 1 day, also on sibling machines (MM-922). A refused sibling pairs again by itself with the browser key. Settings > Connections shows why a sibling is not paired: sign in, waiting for approval, or paused.

- **Limits:** a stolen bearer of a sibling works for up to 1 day. Revisit as MM-922 says.

### Owner-only access changes

Only the owner changes `clientAccess` and `machineMap`: in the portal with the passkey step, or in the desktop app of the machine (MM-919). Agents cannot change them, not even as a proposal.

### App invites and app tokens

Only the owner makes an invite, in the portal. "Invite an app" shows a QR code that a native app, such as the T3 Android app, uses once (MM-913). The app gets its own Cloudflare Access token, and each machine gives it the level of its arrow.

- In the mobile app, scan the code in Add environment, or paste its link in Address. The app then pairs with every machine that it may reach.

### Emergency pause

A big red button in the portal stops all agents and sets all access to `none` (MM-708 to MM-713). While paused, each machine locks T3 Code for every client except its own desktop app (MM-718). Only the owner resumes, in the portal.

- **Limits:** what the mobile app shows while a machine is locked is not checked. Revisit when the pause is tested on Android.

### Scheduled tasks

The Tasks view lists the scheduled tasks of every machine, with Pause, Resume and "Run now" (MM-1601 to MM-1605).

### Health alerts

Each machine sends CPU, memory, disk, swap and battery samples. The portal keeps 30 days of history and raises the alerts HOT, FULL, DISK, SWAP, DOWN and LOW (MM-1501 to MM-1511).

- The CPU alert starts when a machine is starved for CPU, not when it is only busy. On Linux, it uses CPU pressure.
- The battery alert (LOW) starts below 15% on battery, by default. macOS and Linux report the battery.

### Installable portal

The portal installs as an app, with an offline page and an app badge. Turn on Web Push per device in Clients > "Notifications on this device". Pushes go out for health alerts, Inbox proposals, sign-ins that wait for approval, and the pause (MM-1801 to MM-1809).

### Machines panel

A read-only map in the right panel of a thread. Open it from the "+" menu of the panel, or with "Show machines" in the command palette.

- **Works on:** web, desktop.
- **Limits:** the mobile app has no Machines panel. Revisit when the mobile app needs to show machine state.

## Updates and releases

### Fork releases

Nightly desktop builds for macOS, Windows and Linux, plus Linux server archives and `SHA256SUMS`. A release builds on each push to main that changes more than docs or the portal. `t3 update`, "Update everything" and `scripts/install.sh` install from the fork releases. How releases build: [Fork Release](operations.md#fork-release).

- **Works on:** desktop and server.
- **Limits:** macOS builds use a self-made certificate and are not notarized, so the first install needs Control-click > Open. Revisit if the fork gets an Apple developer account.

### Android APK

A signed Android APK of fork main, on fork releases that changed the app. It installs next to the store app and speaks the protocol of fork main.

- **Install:** on the phone, open [Add with Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.yardenzamir.t3code%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2FYarden-zamir%2Ft3code%22%2C%22author%22%3A%22Yarden-zamir%22%2C%22name%22%3A%22T3%20Code%20fork%22%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Atrue%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android%5C%5C%5C%5C.apk%24%5C%22%7D%22%7D). It tracks the fork releases with "Include prereleases" and "Fallback to older releases" on, and the APK filter `android\.apk$`. The portal "Invite an app" dialog has the same link.
- **Install by hand:** open the APK of the newest release that has one, and allow installs from that browser. Install a newer APK over it to update. Most releases have no APK, because only a release that changed the app builds one.
- **Limits:**
  - No push notifications, because the build has no `google-services.json`. Revisit when the fork has a Firebase project.
  - `t3code://` links open the Play Store app, because the APK uses the `t3code-preview` scheme. Revisit when the APK build registers its own scheme for those links.
  - No over-the-air updates, because those come from the upstream Expo project. Update with Obtainium.
  - arm64 phones only.

### Fork installers

One command installs the fork from the fork releases on macOS, Windows or Linux and joins the machine map. The installer does not build from source. Commands and options: [Install the fork](operations.md#install-the-fork).

### Install when idle

While agents run, the desktop update button offers "Install when idle" next to "Install now". The app installs the update when no agent turn runs.

- **Works on:** desktop.
- **Limits:** the wait lives in the window, so a window reload drops it. Revisit if a reload during the wait loses an update in practice.

### Server auto-update

A headless server that runs as the background service installs each newer fork release when no agent turn and no background shell runs.

- **Setting:** server setting `forkAutoUpdate` (off by default). Settings > General > "Server auto-update".
- **Works on:** server (the background service of `t3 service install`). The desktop app updates itself.
- **Limits:** the restart stops running turns. Turn on [Recover interrupted agents](#recover-interrupted-agents) to continue them. Details: [Server updates](operations.md#server-updates).

### Newer update before install

Before the desktop app installs a downloaded update, it checks for a newer release. If one exists, it asks "Download newer" or "Install this one". Install when idle and the machine map take the newer release.

- **Setting:** client setting `checkNewerBeforeUpdateInstall` (off by default). Settings > General > "Check for a newer update before install".
- **Works on:** desktop.

### Changelog

A timeline of fork releases and their commits, the upstream commits that fork main does not have yet, and the Fork Sync runs.

- **Setting:** client setting `forkChangelogEnabled` (on by default). Settings > General > "Fork changelog".
- **Works on:** web and desktop (the Settings row). The update popover is on desktop only.
- **Open it:** from the Fork changelog row in Settings, or from "Open changelog" in the update popover. With the setting on, the update popover shows the changelog of every release between the installed version and the offered one.
- **Releases tab:** commits, newest first, with a divider for each release, its time and an "Installed" mark. A fork icon marks a fork commit, and a down-arrow icon marks an upstream commit. A `#123` in a commit subject links to the pull request of its repository. Merge commits do not show.
- **Upstream tab:** the upstream main commits that fork main does not have yet. "Start Fork Sync" starts the sync and shows the run and each job. It needs the `source-control:write` scope.
- **Ask agent:** opens a thread in the fork project of the same machine, with a changelog chip and a prompt to read and send. The fork project is the first project whose repository is `Yarden-zamir/t3code`, as the only remote or as `origin` beside an `upstream` remote. Without one, the menu shows an error.
- **Limits:**
  - The server reads GitHub with the GitHub credential of its machine (settings, `GH_TOKEN` or `gh auth login`). Without a credential, the changelog shows the GitHub error.
  - Each release costs two GitHub requests, so the timeline shows 10 releases first, and "Show older releases" adds 10 more. A range of more than 500 commits stops at 500 with a note. Revisit if GitHub rate limits become a problem.
  - When GitHub does not answer, the update popover shows the release notes instead.

### Maintainer tools

These README lines are maintainer procedures:

- Local deploy: [Deploy a local build](operations.md#deploy-a-local-build).
- Local Mac build: [Local Mac build](operations.md#local-mac-build).
- Fork Sync: [Fork Sync](operations.md#fork-sync).
- Fork CI: [Fork CI](operations.md#fork-ci).
- Repair agent: [Repair agent](operations.md#repair-agent).

## Agents

### Recover interrupted agents

Every agent runs as a child process of the T3 server, so an update, a crash or a quit stops them all. With this setting, the next server start sends each cut-off thread a short message, so that its agent continues.

- **Setting:** server settings `recoverInterruptedTurns` (off by default), `recoverInterruptedTurnsMessage` (default "Recover and continue") and `recoverInterruptedTurnsSubagentMessage` (default "Recover and continue. Your parent thread was also restarted."). Settings > General > "Recover interrupted agents".
- **Works on:** server.
- A thread gets the message when the restart stopped its turn, or when its finished turn still had open background work: a native subagent, a monitor or a background shell. A delegated thread gets the subagent message.
- The thread shows the message as a "T3 Code restarted" notice. The agent receives the message text.
- No message goes to a thread that you stopped, snoozed or settled, to a turn that ended on its own, to a turn that waited for an answer, an approval or a secret, to a turn that did not start, to a thread without a saved provider session, or to a thread with newer work. Held queued messages stay held.
- **Limits:**
  - A native subagent, for example a Claude Code Task subagent, is not a T3 thread. The message to its parent covers it, with a note that names the stopped work.
  - Each stopped turn gets one message at most. After three recoveries in a row, the thread waits for you, so a restart loop stops.
  - A project that turns off "Continue threads after restarts" gets no message.

### Background work details

Background work notifications name their tasks and output files. A status icon opens a details popover, and descriptions render Markdown links.

- **Setting:** client setting `backgroundWorkDetails` (on by default). Settings > General > "Background work details".
- **Works on:** web, desktop.
- **Limits:** the mobile app shows only the upstream pending work. Revisit when mobile users need the task names and output files.

### Pull requests from origin

A fork checkout lists, reads and watches the pull requests of its fork, not of upstream. Upstream T3 names a checkout by its `upstream` remote first. With this setting, `origin` comes first.

- **Setting:** server setting `preferOriginRemote` (off by default). Settings > Source control > Fork checkouts > "Pull requests from origin".
- **Works on:** server, so every client.
- **Limits:** pull request creation and the pull request of the current branch follow gh's default repository, then `upstream`. Run `gh repo set-default <owner>/<fork>` in each fork checkout. Revisit if a fork checkout without a gh default creates a pull request on upstream.

### Pull request watch remark filter

Selects which comments and reviews wake an agent that watches a pull request.

- **Setting:** server setting `pullRequestWatchRemarkFilter` with `authorAssociations`, `authorLogins` and `agentMarker` (all empty by default). Settings > Source control > Pull request watch: "Roles that wake agents", "Logins that wake agents" and "Agent remark marker".
- **Works on:** server. Edit it on web or desktop.
- With both lists empty, the upstream rule applies: a remark wakes the agent unless the account of the server wrote it.
- With a list set, a remark wakes the agent only when its author matches a role (`OWNER`, `MEMBER`, `COLLABORATOR` and so on) or a login. Logins compare without case. The own-account rule does not apply then.
- A remark that contains `agentMarker`, for example `<!-- agent -->`, never wakes the agent.
- Check, conflict and push news and the comment wake limit do not change.
- **Limits:** a GitHub App bot has no role, and only GitHub reports roles. On other hosts, and for bots, use `authorLogins`.

### Agent session import limits

Sets how far back recent Claude Code and Codex sessions are offered for import, and how many messages an imported session keeps.

- **Setting:** server settings `agentSessionImportWindowDays` (default 30, 1 to 3650) and `agentSessionImportMaxMessages` (default 200, 1 to 10000). Settings > General > "Session import window" and "Imported messages per session".
- **Works on:** server.
- An imported session keeps its first user message and the newest messages up to the limit.

### Scheduled task model

A scheduled task runs on any provider instance, or on the project default model. Pick it in the scheduled task editor.

- **Works on:** web, desktop, mobile.

## Threads

### Sidebar groups

Thread groups show as tabs under the sidebar search. A thread lives in one group, so the groups act like folders.

- **Setting:** client settings `sidebarGroupsEnabled` (off by default) and `sidebarGroupSingleThreadOpens` (off by default). Settings > General > "Sidebar groups" and "Single-thread tabs". The groups are the server setting `sidebarGroups` of the primary server. The machine map syncs them to every machine (MM-411). The mobile app shows the tabs while the server setting `mobileSidebarGroups` is on (off by default): Settings > Appearance > Mobile app, or Fork in the mobile Settings.
- **Works on:** web, desktop. Mobile shows the tabs above the thread list: tap a tab to show its threads.
- **Use it:**
  - The first tab, "Threads", holds every thread that is in no group. It can be renamed, and it can show all threads.
  - Drag a thread onto a tab to move it into that group. During a drag, a + shows at the end of the bar. A drop on it makes a new group.
  - Right-click the bar outside a tab and pick "New group" to make an empty group. Right-click a tab, or click the sliders button of the open tab, to rename it, pick its icon, edit its rules, move it or delete it.
  - Rules put threads in a group. A thread matches a group when it matches every rule. Rules compare the repository, the repository owner, the status, the provider, the creator, the background work and the title. A repository rule matches on every machine.
  - A thread lives in the group that you dragged it into. Otherwise it lives in the first group, from left to right, whose rules match. Otherwise it lives in "Threads".
  - A rule on "Group" makes a view: a tab that shows the threads of other groups. Pick Group > "Any group" for an "All" tab.
  - A tab shows the status of its most urgent thread. Settled and snoozed threads stay in the Settled and Snoozed shelves of their group.
  - With "Single-thread tabs", a group with one thread shows that thread on its tab, and a click opens it.
  - Each tab has an icon, or a dot by default. Turn off "Show the name on the tab" to show the icon only.
  - Tabs that do not fit go to a "+N" menu. Drag a tab to move it; the first tab stays first.
  - Search covers every tab. A thread that you open from a link or a notification shows its tab.
- **Limits:**
  - On mobile, groups cannot be made or edited, threads cannot be moved into a group, and "Single-thread tabs" does not apply. A thread link does not switch to the tab of the thread. Revisit when mobile edits groups.
  - The hosted app at app.t3.codes has no primary server to keep the groups, so it shows no tabs. Revisit if hosted clients get a place for shared settings.
  - When two devices change groups at the same moment, the last change wins. Revisit if groups get lost in practice.
  - A machine without the map role `edit`, or off the map, keeps a change on its own server only.

### Snooze quick options

Edits the choices of the snooze menus.

- **Setting:** client setting `snoozeQuickOptions` (empty by default: the built-in choices). Settings > General > "Snooze quick options".
- **Works on:** web, desktop: the snooze button, the thread menu and the menu for selected threads.
- A choice snoozes for a number of minutes, hours or days, or until a time today, tomorrow or on the next given weekday. A blank label shows a label that names the choice.
- A choice for today shows while its time is more than an hour away. The reset button brings back the built-in choices.
- **Limits:** the mobile app keeps the built-in choices. Revisit when the mobile parity work reaches snooze.

### Worktree path template

A template decides where new worktrees go, for example next to `main/` in a `.bare` container.

- **Setting:** server setting `worktreePathTemplate` (empty by default: the worktree location setting applies). Settings > Storage > "Worktree path template".
- **Works on:** server.
- The variables are `{worktrees}` (the worktree location), `{repoDir}` (the checkout, or the `.bare` container), `{repo}` (the folder name of `{repoDir}`), `{branch}` (with `/` changed to `-`) and `{branchLeaf}` (the last part of the branch). The template must hold `{branch}` or `{branchLeaf}`.
- For a `.bare` container, use `{repoDir}/{branchLeaf}`. A worktree for `feat/api/qcdi-1234-auth` then goes to `<container>/qcdi-1234-auth`, next to `main/`.
- In a normal clone, a template path inside a checkout uses the default worktree location instead, so `{repoDir}/{branchLeaf}` works for both layouts. To place normal clone worktrees elsewhere, use `{worktrees}/{repo}/{branch}` or `{repoDir}/../{repo}-{branch}`.
- With a template, an auto-named thread names its branch from the first six words of its first message, so the folder and the branch keep the same name. The static branch naming mode adds its prefix. A taken name gets a `-1`, `-2` suffix. When a branch such as `t3` blocks `t3/x`, the name becomes `t3-x`.
- **Limits:** a branch that you type, and a pull request branch, keep their names. If their folder exists, the launch fails and names the folder. Use `{branch}` when different branches end in the same last part.

### Thread link chips

Every thread link in chat shows as the chip of an attached thread, and opens the thread in T3 Code.

- **Setting:** server setting `threadLinkChips` (off by default). Settings > Appearance > Thread links > "Thread link chips".
- **Works on:** web, desktop, mobile. Mobile reads the setting of the server of the thread, and has no switch of its own.
- The chip reads `t3-thread://v1/<threadId>`, `t3code://threads/<environmentId>/<threadId>`, `https://<host>/<environmentId>/<threadId>`, and the attached-thread marker `[Thread: <title>; ref=<contextId>]` that agents copy.
- An app link or a web address becomes a chip only when this client knows the environment. Copy keeps the link as written.
- **Limits:** `?message=<messageId>` is kept, but the app does not scroll to the message. Revisit when upstream pingdotgg/t3code#19203 adds message links.

### Thread addresses open the desktop app

A thread address opened from outside T3 Code, for example from Slack or GitHub, hands the thread to the desktop app. The browser tab then shows "Continue here" and "Open in desktop app".

- **Setting:** server setting `threadLinksOpenDesktopApp` (off by default). Settings > Appearance > Thread links > "Thread addresses open the desktop app".
- **Works on:** web browser tabs. The desktop app, the installed web app and app.t3.codes never redirect.
- **Limits:**
  - When the desktop app is not running, the link that starts it is lost (upstream pingdotgg/t3code#18613). Revisit when pingdotgg/t3code#18422 merges upstream.
  - With `threadLinkChips` off, a thread address clicked in T3 web chat opens a new tab that counts as a link from outside, so it goes to the desktop app too. Revisit if users keep `threadLinkChips` off while this setting is on.

### New thread on mobile

What New thread opens in the mobile app.

- **Setting:** server setting `mobileNewThreadProject`: `picker` (default, the project list), `last` (a draft in the project of the last new thread on the phone) or `none` (a draft without a project). Settings > Appearance > Mobile app, or Fork in the mobile Settings.
- **Works on:** mobile.
- Back from the draft shows the project list. A share, a prompt link and "Choose a project" in the draft keep the project list.
- **Limits:** `none` needs a server that offers threads without a project. Without one, and with `last` and no earlier new thread, the project list shows.

### Camera in the mobile composer

The plus button of the mobile composer, the new thread draft and question answers offers "Take Photo" next to "Photo Library" and "Choose Files".

- **Setting:** server setting `mobileComposerCamera` (off by default, because on a server without file attachments the plus button opens a menu instead of the photo library). Settings > Appearance > Mobile app, or Fork in the mobile Settings.
- **Works on:** mobile.
- **Limits:** photos only, because the app asks for no microphone access. Revisit if video from the camera is needed.

### Thread card layouts

Build the thread card from its elements, for desktop and web and for mobile.

- **Setting:** server setting `threadCardLayouts` with `desktop` and `mobile` (both `null` by default: the built-in card). Settings > Appearance > Thread cards. The setting is shared with every connected server that supports shared settings.
- **Works on:** web, desktop, mobile.
- A layout is rows of elements. Each row has a left group that takes the free width and a right group that keeps its size. Drag an element into the Hidden tray to hide it. The title and the status cannot be hidden.
- Each element carries `data-thread-card-element="<name>"`, so theme CSS can style one element.
- **Limits:** the mobile tab offers no terminal or diff element. The preview shows the mobile arrangement with web styles. Sidebar search results and app.t3.codes keep the built-in card.

## Filters

### Repository owner filters

Filters the pull request page and the sidebar by the owner of each repository: a GitHub account or organization.

- **Setting:** client setting `repositoryOwnerFilters` (on by default). Settings > General > "Repository owner filters". The sidebar choice is the client setting `sidebarOwnerFilter`.
- **Works on:** web, desktop.
- Pull request page: open Filters > Owner, pick "Show only selected" or "Hide selected", then pick the owners. In the search, type `org:` or `owner:` to show an owner, and `-org:` or `-owner:` to hide one.
- Sidebar: click the building icon next to the project scope. A chip under the header names the filter, counts the hidden projects, and shows how many hidden threads need you.
- A fork checkout counts under the owner of the fork in the sidebar, and under the upstream owner on the pull request page. A project without a remote has no owner: pick "No repository owner" for it.
- **Limits:** the mobile app has no owner filter. Revisit when the mobile parity work reaches filters.

### Pull request filter chips

The active pull request filters show as chips above the list.

- **Setting:** client setting `pullRequestFilterChips` (on by default). Settings > General > "Pull request filter chips".
- **Works on:** web, desktop.
- Click "is" or "is not" on a chip to flip it. A label flips into a typed `-label:`. Click × to remove a filter, or "Clear all".
- When no pull request matches, the empty list names the filters and offers "Clear filters".
- **Limits:** typed qualifiers stay in the search box and get no chip. The mobile app has its own filter menu. Revisit when the mobile parity work reaches filters.

## Scripts and terminal

### Global scripts

Scripts for every project, pinned script buttons, floating previews and app overlays.

- **Setting:** server settings `globalScripts`, `pinnedGlobalScriptIds` and `pinnedProjectScriptIds` (all empty by default). Settings > General > Global scripts.
- **Works on:** web, desktop.
- Pin a script to get a button. Global pins show in the title bar. Project pins show next to the thread details toggle. Right-click a button for the pin menu.
- A global script's preview opens as a floating popup. A script can run in the background without the terminal drawer (`runInBackground`).
- An action with "Open as an app overlay" (`previewOverlay`) opens its page in a large panel over the app. It runs its command only when the page is down.
- **Limits:** a remote client opens an app overlay in the preview instead, because it cannot frame the page. The mobile app runs project scripts only. Revisit when the mobile parity work reaches scripts.

### App toggle shortcuts

Global keys that show and hide the desktop app.

- **Setting:** client setting `appToggleShortcuts` (empty by default). Settings > General > "App toggle shortcuts", for example `F17, Alt+Space`.
- **Works on:** desktop.
- Each entry is an Electron accelerator. The settings field rejects a key that Electron cannot name.
- **Limits:** the ISO section key `§` has no Electron name. Map it to a function key, for example with Karabiner. If another app holds a key, the desktop app logs a warning and skips it. On macOS, the app hides without animation.

### Keyboard focus levels

Escape moves focus from the composer to the timeline, then to the sidebar. Arrow keys move a cursor there to open threads, switch groups and cite parts of messages.

- **Setting:** client settings `keyboardFocusLevels` (off by default) and `focusLevelHighlight` (on by default). Settings > General > "Keyboard focus levels" and "Focus highlight". Change the keys in Settings > Keybindings (`focus.*`, `sidebar.*` and `timeline.*` commands).
- **Works on:** web, desktop.
- Keys for thread actions, approvals and right panel tabs, and `mod+,` on web, work with the setting off.
- `focusLevelHighlight` outlines the area that takes focus from a key.
- **Limits:** the setting is off by default because it changes existing keys. Escape in the timeline and the right panel moves focus. A click into the timeline makes Up and Down move the cursor instead of scrolling. `mod+f` in the sidebar focuses sidebar search. Letters typed in the sidebar no longer go to the composer, and digits switch groups.

### Shortcuts in tooltips

Control tooltips show the keys of the control as chips, such as "Stash ⌘S", for example on the stash, the runtime mode and the approval buttons.

- **Setting:** client settings `tooltipShortcuts` (on by default) and `tooltipShortcutLimit` (default 4, 1 to 9). Settings > General > "Shortcuts in tooltips" and "Keys per tooltip".
- **Works on:** web, desktop.
- Your own keys come first. More keys than the limit show as "+N".
- **Limits:** a group tab names no digit while focus levels are off. A sidebar row names the pin and settle keys only for the open thread.

### Terminal settings

App shortcuts take priority in a focused terminal, and the app asks before a terminal closes.

- **Setting:** client settings `terminalAppShortcutsFirst` (off by default) and `confirmTerminalClose` (on by default). Settings > General > "App shortcuts in terminal" and "Terminal close confirmation".
- **Works on:** web, desktop.
- **Limits:** the mobile app does not ask before a terminal closes. Revisit if a mobile user closes a running terminal by mistake.

## Web app and look

### Installed web app

Each server web app, such as `https://t3-vps.yarden-zamir.com`, installs as an app, with an offline page, notifications and an app badge.

- **Setting:** client setting `installedAppEnabled` (on by default). Settings > General > "Installed app", in each browser and for each server.
- **Works on:** web browsers. Desktop Chrome and Edge show "Install" in the address bar. Android Chrome shows "Install app" in its menu. On iPhone, use Share > Add to Home Screen.
- The app has shortcuts for a new thread, pull requests and settings. On Android, long-press the app icon.
- The offline page shows when the device is offline, or when the tunnel answers but the server is down.
- Android and iPhone show thread and review guide notifications. Turn on notifications in Settings > General first.
- The app icon shows the same count as the browser tab icon.
- The service worker caches only the offline page. A new build thus shows at once, and Cloudflare Access can ask for a new sign-in.

### Web Push

A phone gets thread notifications while the installed app is closed, from each server that the page connects to.

- **Setting:** client setting `webPushEnabled` (on by default). Settings > General > "Web Push". It needs the installed app setting and system notifications. "Send a test" sends a test push.
- **Works on:** web browsers, mainly the installed web app on a phone. The native mobile app has its own push, see [Android APK](#android-apk).
- A server pushes when a thread starts to wait for approval or input, or when a running thread completes or fails.
- A push replaces the page notification of the same thread. No push shows when the window in front already shows that thread.

### Theme style

Published themes can set shape, fonts, a canvas pattern and user CSS, in the theme JSON fields `radius`, `borderWidth`, `shadow`, `fonts`, `canvasPattern`, `canvasPatternColor` and `css`.

- **Setting:** none. Select a published theme in Settings > Appearance. See [Appearance](../user/appearance.md) for published themes.
- **Works on:** web, desktop, and mobile with [Themes on mobile](#themes-on-mobile).
- **Limits:** see [Themes on mobile](#themes-on-mobile) for the fields that mobile skips.

### Themes on mobile

The mobile app uses the themes that its servers publish.

- **Setting:** server setting `mobilePublishedThemes` (off by default). Settings > Appearance > Mobile app, or Fork in the mobile Settings. The machine map syncs it.
- **Works on:** mobile.
- Appearance in the mobile app shows the published themes under "From your servers". A theme with colors for one appearance offers that appearance only.
- The app takes the server setting `defaultTheme` once for each theme id, for the appearances that the theme has colors for. The color scheme mode stays as set on the phone.
- The app stores the last published themes, so the theme shows before a server connects.
- Shape: `radius` sets every radius token except round elements, `borderWidth` sets every border, and `shadow` goes on grouped lists, the composer and the Android buttons. `apps/mobile/fork-theme.css` holds the tokens, and class rules make the fixed pixel radii of upstream (`rounded-[20px]`) follow them.
- A `shadow` that the app cannot read is dropped.
- Fonts: the app bundles Bricolage Grotesque and JetBrains Mono. A theme font with one of these names replaces the stock font.
- Canvas: `dots` and `grid` show behind the thread feed.
- **Limits:**
  - A theme that lists only `canvas` and `accent` gets only those two colors, because the palette generator lives in `apps/web/src/themePalette.ts`. Revisit when such a theme is in use on a phone, or when upstream moves the generator to `packages/shared`.
  - A pixel radius class that upstream adds later keeps its size under a theme until `fork-theme.css` gets a rule for it.
  - Other fonts keep the stock font. The composer takes the `sans` font, and the terminal and diff views keep the platform monospace font.
  - `noise`, user CSS and icon packs have no mobile form. The text of the Android buttons keeps the system font.
  - Setting the same `defaultTheme` again does not apply it again on the phone, because `defaultThemeSetAt` is local to each machine.

### Fork settings on mobile

Fork in the mobile Settings holds the fork settings that apply to the mobile app: published themes, the camera in the composer, thread link chips and what New thread opens. A change writes the setting to each selected environment.

- **Works on:** mobile.
- **Limits:** a change on the phone is the own value of each server, not the shared value of the machine map. Set the shared value in the portal or from a machine with the map role `edit`.

### Theme icon packs

A published theme can replace app icons with its own SVGs, in the theme JSON field `icons`. Without it, every icon stays stock.

- **Works on:** web, desktop.
- The slots are the sidebar group icons (`group.<id>`), the thread statuses (`status.<status>`), the group tab bar buttons (`groups.more`, `groups.new`, `groups.edit`) and the sidebar header (`sidebar.search`, `sidebar.filter`, `sidebar.add-project`, `sidebar.new-thread`). `apps/web/src/components/AppIcon.tsx` lists them.
- Each icon carries `data-app-icon="<slot>"`. The group tabs carry `data-sidebar-group-tab`, `data-selected`, `data-status`, `data-attention` and `data-drop-target` for theme CSS.
- The tick3d themes in the dotfiles carry a neo-brutalism pack. The `t3-theme` skill in the dotfiles describes the fields.
- **Limits:** the app strips scripts, styles, links and remote content from each SVG, and an icon is at most 4096 characters. The mobile app shows stock icons. Revisit after sidebar groups reach mobile.

### Local server groups

The Local servers list of a new browser tab also shows servers that no T3 terminal started. They are in groups: this worktree, other folders of this project, and all others.

The list fills in progressively. Every server shows as soon as the server knows its folder. A server that gets a check shows "checking…" until its first check ends, then "no page found" or no note. Rows keep the order in which they first appeared.

A row shows "from <thread>" when the server knows for certain which other thread started it. A click on the chip opens that thread. For a server of a T3 terminal, that is the thread of the terminal. For a server that an agent started, the server looks up the process tree for the session id of a Claude Code or Codex process that T3 runs.

- **Setting:** server setting `previewLocalServerGroups` (off by default). Settings > Integrations > Browser > "All local servers in the browser".
- **Works on:** web, desktop. The mobile app has no Local servers list.
- **Limits:**
  - A request to an unknown app can crash it (upstream pingdotgg/t3code#18377). The server checks only servers inside a project. Others show the port and the process name with "not checked". A click opens them anyway.
  - An app such as Maya or Blender that starts from a project folder still gets a check. The setting is the opt-in.
  - On Windows, every server outside the T3 terminals is in the last group. Revisit if Windows gets a cheap way to read the working folder of a process.
  - A port with two owner processes, such as one on IPv4 and one on IPv6, gets no check. A project at the home folder or above it counts as no project.
  - A new project or thread worktree counts after up to 30 seconds. A worktree that no thread uses counts after up to 5 minutes.
  - A server whose shell exited has no "from" link on macOS, because macOS hides the environment of other processes. On Linux the server also reads `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` from the process environment. Windows has no "from" link for agent servers.

### Lightning icon

The fork desktop app, its notifications and the bundled web page use the Tick3d lightning icon instead of the nightly icon. To change it, see [App icon](operations.md#app-icon).

- **Works on:** desktop, web, Android APK. The APK uses the layers `assets/fork/tick3d-android-{foreground,background,monochrome}.svg`, as PNG files in `apps/mobile/assets/fork/`.
- **Limits:** iOS builds keep the nightly icon.

## Command line and MCP

### `t3 tool`

`t3 tool list`, `t3 tool describe <name>` and `t3 tool call <name> --input '<json>'` run T3 MCP tools from the command line. In a checkout, use `node apps/server/src/bin.ts` instead of `t3`.

- **Works on:** server.
- In an agent terminal, the command uses the credential of the thread. Otherwise it calls the running server of its T3 home.

### Open workspace with a checkout

The desktop open-workspace request accepts a checkout.

- **Works on:** desktop.
