# Yarden-zamir fork of T3 Code

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The upstream README starts below the line. Each fork behavior is a setting that starts on when it only adds something, and off when it changes behavior, installs or restarts anything, changes access or needs setup. Settings > Fork shows every fork setting, in the groups of this list. Details and setup: [docs/fork.md](docs/fork.md).

## Fork features

**Remote access**

- **Cloudflare Access login:** the server accepts the Cloudflare Access JWT as the owner login (`cloudflareAccessTeamDomain`, `cloudflareAccessAud`, `cloudflareAccessSubjects`).
- **Request headers per environment:** a saved environment sends its own headers, for example a Cloudflare Access service token. Edit them in Settings > Connections.
- **Tunnel pairing:** a desktop server that listens on loopback makes pairing links with its tunnel URL (`tunnelPairingEnabled`, `tunnelPairingUrl`).
- **Trusted sibling environments:** trusted browser origins get credentialed CORS and session cookies. One browser page pairs and reaches the other hosts (`trustedBrowserOrigins`).

**Machine map** (all lines need `machineMap`, which a join to a map turns on)

- **Portal:** one portal at `t3.yarden-zamir.com` (Cloudflare Worker) maps every T3 machine and sets what each machine can do on the others. Requirements: `apps/machine-map/SPEC.md`.
- **Portal views:** Map, Table, Health, Settings, Queue, Tasks, History, Inbox and Clients. Every portal action is also an agent tool: `machines_*` and `machine_tool_call`.
- **Join and install:** "Add machine" shows one command per system that installs the fork and joins with a one-time code. The portal makes the tunnel of the machine.
- **Join feedback:** the open join dialog shows when a machine uses the code, and if it connected.
- **Emergency pause:** a big red button stops all agents and sets all access to none. While paused, each machine locks T3 Code for every client except its own desktop app.
- **Scheduled tasks:** the Tasks view lists the scheduled tasks of every machine, with pause, resume and run now.
- **Health alerts:** each machine sends CPU, memory, disk, swap and battery samples. The CPU alert starts when a machine is starved for CPU, not when it is only busy. The battery alert starts below 15% on battery, by default.
- **Installable portal:** the portal installs as an app, with an offline page, an app badge and Web Push for alerts, proposals, waiting sign-ins and the pause.
- **Settings and theme sync:** a setting with a shared value syncs to every machine. A change with "All environments" in T3 Settings sets the shared value. Custom themes (the `themes/` folder) and `defaultTheme` sync too.
- **Settings > Machines:** join or leave the map with a code, and see the machines that this machine can reach.
- **Desktop app on the map:** the desktop app adds each reachable machine as an environment and applies the shared client settings.
- **Zoom and pan:** the map zooms, pans and fits all cards, also on phones and small windows.
- **Approved clients:** a new browser waits in the Clients view until the owner approves it with a fresh MFA. Each client gets a card and a level per machine.
- **Client access:** each machine decides which browsers get in through Cloudflare Access. `off` keeps the owner login. `observe` gives a browser of an approved client the level of its arrow, at most `standard`. `enforce` lets in only browsers of approved clients; other browsers wait for approval (`clientAccess`).
- **Owner-only access changes:** only the owner changes `clientAccess` and `machineMap`, in the portal with the passkey step or in the desktop app of the machine. Agents cannot change them.
- **Sibling client sessions:** a browser client session lasts 1 day, also on sibling machines. A refused sibling pairs again by itself with the browser key.
- **App invites and app tokens:** only the owner makes an invite, in the portal. "Invite an app" shows a QR code that a native app, such as the T3 Android app, uses once. The app gets its own Cloudflare Access token, and each machine gives it the level of its arrow.
- **Machines panel:** a read-only map in the right panel of a thread. Open it with "Show machines" in the command palette.

**Updates and releases**

- **Fork releases:** nightly desktop builds for macOS (signed with a self-made certificate), Windows and Linux, plus Linux server archives and `SHA256SUMS`. A release builds on each push to main that changes more than docs or the portal. `t3 update`, "Update everything" and `scripts/install.sh` install from the fork releases.
- **Fork installers:** one command installs the fork from the fork releases on macOS, Windows or Linux and joins the machine map. The installer has no source build.
- **Install when idle:** while agents run, the update offers "Install when idle" next to "Install now".
- **Server auto-update:** a headless server that runs as the background service installs each newer fork release when no agent turn runs (`forkAutoUpdate`).
- **Local deploy:** `scripts/fork-deploy-local.sh <ssh-host>` builds this checkout for a headless Linux server and switches its service to it.
- **Changelog:** a timeline of fork releases and commits, also in the update popover for the offered update, the pending upstream commits, a "Start Fork Sync" button and an "Ask agent" menu (`forkChangelogEnabled`, on by default).
- **Fork Sync:** a daily workflow merges upstream main into fork main. It never rewrites main.
- **Fork CI:** runs on each push to main and on each pull request to main. Branch protection requires the one check "Fork CI result".
- **Repair agent:** a failed Fork Sync or Fork Release run, or a failed Fork CI run on main, calls the webhook task "Fork repair" on the VPS, which starts a repair agent. A pull request never calls it.

**Agents**

- **Recover interrupted agents:** after a restart, each cut-off thread gets a "Recover and continue" message (`recoverInterruptedTurns`).
- **Background work details:** background work notifications name their tasks and output files, with a details popover (`backgroundWorkDetails`, on by default).
- **Pull requests from origin:** a fork checkout lists, reads and watches the pull requests of its fork, not of upstream (`preferOriginRemote`).
- **Pull request watch remark filter:** select which comments and reviews wake an agent that watches a pull request (`pullRequestWatchRemarkFilter`).
- **Agent session import limits:** set the import window and the message limit for imported agent sessions (`agentSessionImportWindowDays`, `agentSessionImportMaxMessages`).
- **Scheduled task model:** a scheduled task runs on any provider instance, or on the project default model.

**Threads**

- **Sidebar groups:** thread groups as tabs above the sidebar list, filled by drag or by rules. The machine map syncs the groups to every machine (`sidebarGroupsEnabled`; `sidebarGroupSingleThreadOpens`; `sidebarGroups`).
- **Snooze quick options:** edit the choices of the snooze menus (`snoozeQuickOptions`).
- **Worktree path template:** a template decides where new worktrees go, for example next to `main/` in a `.bare` container (`worktreePathTemplate`).

**Filters**

- **Repository owner filters:** filter the pull request page and the sidebar by repository owner. Type `org:` or `-org:` in the pull request search (`repositoryOwnerFilters`, on by default).
- **Pull request filter chips:** the active pull request filters show as chips that flip between "is" and "is not" (`pullRequestFilterChips`, on by default).

**Scripts and terminal**

- **Global scripts:** scripts for every project, pinned script buttons, floating previews and app overlays (`globalScripts`, `pinnedGlobalScriptIds`, `pinnedProjectScriptIds`).
- **App toggle shortcuts:** global keys that show and hide the desktop app (`appToggleShortcuts`).
- **Terminal settings:** app shortcuts first in the terminal, and a confirmation before a terminal closes (`terminalAppShortcutsFirst`; `confirmTerminalClose`, on by default).

**Web app and look**

- **Installed web app:** each server web app installs as an app, with an offline page, worker notifications and an app badge (`installedAppEnabled`, on by default).
- **Thread card layouts:** build the thread card from its elements, for desktop and for mobile (`threadCardLayouts`).
- **Theme style:** published themes can set shape, fonts, a canvas pattern and user CSS.
- **Lightning icon:** the fork app uses its own icon on every nightly icon file.

**Command line and MCP**

- **`t3 tool`:** `t3 tool list`, `describe` and `call` run T3 MCP tools from the command line.
- **Open workspace with a checkout:** the desktop open-workspace request accepts a checkout.

## Fork fixes

- Themes: border width and radius flow through Tailwind tokens. Composer backdrop, outline and banners follow the theme radius. One theme shadow for nested surfaces and for split buttons.
- MCP: `schedule_task`, `t3_project_create` and `t3_project_update` read and write the project model, environment mode, auto-pull and actions through project settings.
- Desktop updates: the updater never downgrades, so a local build stays installed. The server recovers when quit-and-install does not quit.
- Worktree launch: a worktree request in Scratch runs in a thread folder. A worktree request outside a Git repository runs in the project folder and says so in the thread. A launch refuses a new worktree branch that already exists.

---

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
