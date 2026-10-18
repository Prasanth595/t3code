# Yarden-zamir fork of T3 Code

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The upstream README starts below the line. Each fork behavior is a setting that starts on when it only adds something, and off when it changes behavior, installs or restarts anything, changes access or needs setup. Settings > Fork shows every fork setting, in the groups of this list. Each line links to its section in [docs/fork/features.md](docs/fork/features.md). Maintainer procedures: [docs/fork/operations.md](docs/fork/operations.md).

## Fork features

**Remote access**

- **[Cloudflare Access login](docs/fork/features.md#cloudflare-access-login):** the server accepts the Cloudflare Access JWT as the owner login.
- **[Request headers per environment](docs/fork/features.md#request-headers-per-environment):** a saved environment sends its own headers, for example a Cloudflare Access service token.
- **[Tunnel pairing](docs/fork/features.md#tunnel-pairing):** a desktop server on loopback makes pairing links with its tunnel URL.
- **[Trusted sibling environments](docs/fork/features.md#trusted-sibling-environments):** one browser page pairs with and reaches the other hosts.

**Machine map** (all lines need `machineMap`, which a join to a map turns on)

- **[Portal](docs/fork/features.md#machine-map):** one portal at `t3.yarden-zamir.com` maps every T3 machine and sets what each machine can do on the others.
- **[Environment name from machine map](docs/fork/features.md#environment-name-from-machine-map):** an optional setting keeps environment names equal to machine map names, also after a name change.
- **[Portal views](docs/fork/features.md#portal-views):** Map, Table, Health, Settings, Queue, Tasks, History, Inbox and Clients.
- **[Join and install](docs/fork/features.md#join-and-install):** "Add machine" shows one command per system that installs the fork and joins.
- **[Join feedback](docs/fork/features.md#join-and-install):** the open join dialog shows when a machine uses the code, and whether it connected.
- **[Emergency pause](docs/fork/features.md#emergency-pause):** a big red button stops all agents and sets all access to none.
- **[Scheduled tasks](docs/fork/features.md#scheduled-tasks):** the Tasks view lists the scheduled tasks of every machine.
- **[Health alerts](docs/fork/features.md#health-alerts):** CPU, memory, disk, swap and battery alerts per machine.
- **[Installable portal](docs/fork/features.md#installable-portal):** the portal installs as an app, with Web Push for alerts.
- **[Settings and theme sync](docs/fork/features.md#settings-and-theme-sync):** a setting with a shared value syncs to every machine, also themes and keybindings.
- **[Settings > Machines](docs/fork/features.md#settings--machines):** join or leave the map, and see the machines that this machine can reach.
- **[Desktop app on the map](docs/fork/features.md#desktop-app-on-the-map):** the desktop app adds each reachable machine as an environment.
- **[Zoom and pan](docs/fork/features.md#zoom-and-pan):** the map zooms, pans and fits all cards, with "Auto layout".
- **[Approved clients](docs/fork/features.md#approved-clients):** a new browser waits until the owner approves it.
- **[Client access](docs/fork/features.md#client-access):** each machine decides which browsers get in through Cloudflare Access.
- **[Owner-only access changes](docs/fork/features.md#owner-only-access-changes):** only the owner changes `clientAccess` and `machineMap`.
- **[Sibling client sessions](docs/fork/features.md#sibling-client-sessions):** a browser client session lasts 1 day, also on sibling machines.
- **[App invites and app tokens](docs/fork/features.md#app-invites-and-app-tokens):** "Invite an app" shows a QR code that a native app uses once.
- **[Machines panel](docs/fork/features.md#machines-panel):** a read-only map in the right panel of a thread.

**Updates and releases**

- **[Fork releases](docs/fork/features.md#fork-releases):** nightly desktop builds and Linux server archives from fork main.
- **[Android APK](docs/fork/features.md#android-apk):** a signed APK of fork main that installs next to the store app.
- **[Fork installers](docs/fork/features.md#fork-installers):** one command installs the fork and joins the machine map.
- **[Install when idle](docs/fork/features.md#install-when-idle):** while agents run, the update offers "Install when idle".
- **[Server auto-update](docs/fork/features.md#server-auto-update):** a headless server installs each newer fork release when idle.
- **[Newer update before install](docs/fork/features.md#newer-update-before-install):** the desktop app checks for a newer release before it installs.
- **[Changelog](docs/fork/features.md#changelog):** a timeline of fork releases, upstream commits and Fork Sync runs.
- **[Local deploy](docs/fork/operations.md#deploy-a-local-build):** `scripts/fork-deploy-local.sh <ssh-host>` deploys this checkout to a headless Linux server.
- **[Local Mac build](docs/fork/operations.md#local-mac-build):** `scripts/fork-desktop-mac.sh` builds and signs the Mac app from this checkout.
- **[Fork Sync](docs/fork/operations.md#fork-sync):** a daily workflow merges upstream main into fork main.
- **[Fork CI](docs/fork/operations.md#fork-ci):** runs on each push and pull request to main; branch protection requires "Fork CI result".
- **[Repair agent](docs/fork/operations.md#repair-agent):** a failed Fork Sync, Fork Release or Fork CI run on main calls an agent on the VPS.

**Agents**

- **[Recover interrupted agents](docs/fork/features.md#recover-interrupted-agents):** after a restart, each cut-off thread gets a "Recover and continue" message.
- **[Background work details](docs/fork/features.md#background-work-details):** background work notifications name their tasks and output files.
- **[Pull requests from origin](docs/fork/features.md#pull-requests-from-origin):** a fork checkout uses the pull requests of its fork, not of upstream.
- **[Pull request watch remark filter](docs/fork/features.md#pull-request-watch-remark-filter):** select which comments and reviews wake a watching agent.
- **[Agent session import limits](docs/fork/features.md#agent-session-import-limits):** the import window and the message limit for imported sessions.
- **[Scheduled task model](docs/fork/features.md#scheduled-task-model):** a scheduled task runs on any provider instance, or on the project default model.

**Threads**

- **[Sidebar groups](docs/fork/features.md#sidebar-groups):** thread groups as tabs above the sidebar list, filled by drag or by rules. Mobile shows and edits them too.
- **[Snooze quick options](docs/fork/features.md#snooze-quick-options):** edit the choices of the snooze menus.
- **[Worktree path template](docs/fork/features.md#worktree-path-template):** a template decides where new worktrees go.
- **[Thread link chips](docs/fork/features.md#thread-link-chips):** every thread link in chat shows as an attached-thread chip.
- **[Thread addresses open the desktop app](docs/fork/features.md#thread-addresses-open-the-desktop-app):** a thread address from Slack or GitHub opens the desktop app.
- **[New thread on mobile](docs/fork/features.md#new-thread-on-mobile):** New thread in the mobile app opens the project list, the last project, or no project.
- **[Camera in the mobile composer](docs/fork/features.md#camera-in-the-mobile-composer):** the plus button of the mobile composer can take a photo.

**Filters**

- **[Repository owner filters](docs/fork/features.md#repository-owner-filters):** filter the pull request page and the sidebar by repository owner.
- **[Pull request filter chips](docs/fork/features.md#pull-request-filter-chips):** the active pull request filters show as chips.

**Scripts and terminal**

- **[Global scripts](docs/fork/features.md#global-scripts):** scripts for every project, pinned buttons, floating previews and app overlays.
- **[App toggle shortcuts](docs/fork/features.md#app-toggle-shortcuts):** global keys that show and hide the desktop app.
- **[Keyboard focus levels](docs/fork/features.md#keyboard-focus-levels):** Escape moves focus between composer, timeline and sidebar; arrow keys move a cursor.
- **[Shortcuts in tooltips](docs/fork/features.md#shortcuts-in-tooltips):** control tooltips show the keys of the control as chips.
- **[Terminal settings](docs/fork/features.md#terminal-settings):** app shortcuts first in the terminal, and a confirmation before a terminal closes.

**Web app and look**

- **[Installed web app](docs/fork/features.md#installed-web-app):** each server web app installs as an app, with an offline page and an app badge.
- **[Web Push](docs/fork/features.md#web-push):** a phone gets thread notifications while the app is closed.
- **[Thread card layouts](docs/fork/features.md#thread-card-layouts):** build the thread card from its elements, for desktop and for mobile.
- **[Local server groups](docs/fork/features.md#local-server-groups):** the browser Local servers list also shows servers that no T3 terminal started.
- **[Theme style](docs/fork/features.md#theme-style):** published themes set shape, fonts, a canvas pattern and user CSS.
- **[Theme icon packs](docs/fork/features.md#theme-icon-packs):** a published theme replaces app icons with its own SVGs.
- **[Themes on mobile](docs/fork/features.md#themes-on-mobile):** the mobile app uses the published themes of its servers, with their fonts, shape and canvas pattern.
- **[Fork settings on mobile](docs/fork/features.md#fork-settings-on-mobile):** a Fork page in the mobile Settings.
- **[Lightning icon](docs/fork/features.md#lightning-icon):** the fork app and the Android APK use their own icon.

**Command line and MCP**

- **[`t3 tool`](docs/fork/features.md#t3-tool):** `t3 tool list`, `describe` and `call` run T3 MCP tools from the command line.
- **[Open workspace with a checkout](docs/fork/features.md#open-workspace-with-a-checkout):** the desktop open-workspace request accepts a checkout.

## Fork fixes

- Themes: border width and radius flow through Tailwind tokens. Composer backdrop, outline and banners follow the theme radius. One theme shadow for nested surfaces and for split buttons.
- MCP: `schedule_task`, `t3_project_create` and `t3_project_update` read and write the project model, environment mode, auto-pull and actions through project settings.
- Desktop updates: the updater never downgrades, so a local build stays installed. The server recovers when quit-and-install does not quit.
- Worktree launch: a worktree request in Scratch runs in a thread folder. A worktree request outside a Git repository runs in the project folder and says so in the thread. A launch refuses a new worktree branch that already exists.
- Queue: a resumed queued turn shows after the turns that ran before it. A paused queue shows while a turn runs. Resume waits for an edit and for a usage limit.
- Machine map: an expired machine arrow ends the sessions that it granted.
- Device panel: a Homebrew Android SDK (`android-commandlinetools`) works without `ANDROID_HOME`, also when the `adb` on `PATH` has no emulator.

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
