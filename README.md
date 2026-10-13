# Yarden-zamir fork of T3 Code

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The upstream README starts below the line. Every fork behavior in the app is a setting, and each setting is off by default. Details and setup: [docs/fork.md](docs/fork.md).

## Fork features

**Remote access**

- **Cloudflare Access login:** the server accepts the Cloudflare Access JWT as the owner login (`cloudflareAccessTeamDomain`, `cloudflareAccessAud`, `cloudflareAccessSubjects`).
- **Request headers per environment:** a saved environment sends its own headers, for example a Cloudflare Access service token. Edit them in Settings > Connections.
- **Tunnel pairing:** a desktop server that listens on loopback makes pairing links with its tunnel URL (`tunnelPairingEnabled`, `tunnelPairingUrl`).
- **Trusted sibling environments:** trusted browser origins get credentialed CORS, and the server accepts its session cookie from them. One browser page pairs and reaches the other hosts (`trustedBrowserOrigins`).

**Updates and releases**

- **Fork releases:** nightly desktop builds for macOS (signed with a self-made certificate), Windows and Linux, plus a Linux server archive for machines without a display. A release builds when the app shell changes, and once a day.
- **Fork installers:** one command installs the fork on macOS, Windows or Linux and joins the machine map. Linux builds from source with a systemd user service.
- **Live server updates:** the desktop app runs its server and web client from a live folder. The update button offers a new main commit in blue, before "update everything", and only the server restarts (`T3CODE_DESKTOP_LIVE_SERVER_DIR`).
- **Install when idle:** while agents run, the update offers "Install when idle" next to "Install now", also at the end of "update everything".
- **Changelog:** a timeline of fork releases with every fork and upstream commit, the pending upstream commits, a "Start Fork Sync" button, and an "Ask agent" menu (`forkChangelogEnabled`).
- **Fork Sync:** a daily workflow merges upstream main into fork main. It never rewrites main.
- **Repair agent:** a failed sync or release calls a webhook that starts a repair agent.
- **VPS deploy:** the VPS follows fork main. It skips the build for docs-only commits, builds once per burst of merges at low priority, and switches only when no agent runs.

**Agents**

- **Recover interrupted agents:** after a restart, each cut-off thread gets a "Recover and continue" message. Subagents get their own message. Snoozed and settled threads stay asleep (`recoverInterruptedTurns`).
- **Background work details:** background work notifications name their tasks and output files, and a popover shows the details with links (`backgroundWorkDetails`).
- **Pull requests from origin:** a fork checkout lists, reads and watches the pull requests of its fork, not of upstream (`preferOriginRemote`).
- **Pull request watch remark filter:** select which comments and reviews wake an agent that watches a pull request, by author role, login and agent marker (`pullRequestWatchRemarkFilter`).
- **Agent session import limits:** set the import window and the message limit for imported agent sessions (`agentSessionImportWindowDays`, `agentSessionImportMaxMessages`).

**Threads**

- **Snooze quick options:** edit the choices of the snooze menus. Each choice snoozes for a time, or until a time of day, with an optional label (`snoozeQuickOptions`).

**Filters**

- **Repository owner filters:** filter the pull request page and the sidebar by the account or organization that owns each repository. Show only some owners, or hide them. Type `org:` or `-org:` in the pull request search (`repositoryOwnerFilters`).
- **Pull request filter chips:** the active pull request filters show as chips above the list. Flip a chip between "is" and "is not", or remove it. An empty list names the filters that emptied it (`pullRequestFilterChips`).

**Scripts and terminal**

- **Global scripts:** scripts for every project and pinned script buttons. Global pins show in the title bar and next to the thread details toggle; project pins show only next to the toggle. Right-click opens the in-app pin menu. A global script's preview opens as a floating popup. An action with "Open as an app overlay" opens its page in a large panel over the app instead, and runs its command only when the page is down (`previewOverlay`). Scripts can run in the background (`globalScripts`, `pinnedGlobalScriptIds`, `pinnedProjectScriptIds`).
- **App toggle shortcuts:** global keys that show and hide the desktop app at once, like a Raycast hotkey (`appToggleShortcuts`).
- **Terminal settings:** app shortcuts first in the terminal, and a confirmation before a terminal closes (`terminalAppShortcutsFirst`, `confirmTerminalClose`).

**Themes and look**

- **Theme style:** published themes can set shape, fonts, a canvas pattern and user CSS.
- **Lightning icon:** the fork app uses its own icon on every nightly icon file.

**Command line and MCP**

- **`t3 tool`:** `t3 tool list`, `describe` and `call` run T3 MCP tools from the command line.
- **Open workspace with a checkout:** the desktop open-workspace request accepts a checkout.
- **Machine map:** one portal at `t3.yarden-zamir.com` (Cloudflare Worker) maps every T3 machine. It sets what each machine can do on the others, shares settings, queues changes for offline machines, and has an emergency pause. Every portal action is also an agent tool (`machineMap`, see `apps/machine-map/SPEC.md`).

## Fork fixes

- Themes: border width and radius flow through Tailwind tokens. Composer backdrop, outline and banners follow the theme radius. One theme shadow for nested surfaces and for split buttons.
- MCP: `schedule_task`, `t3_project_create` and `t3_project_update` read and write the project model, environment mode, auto-pull and actions through project settings.
- Desktop updates: the updater never downgrades, so a local build stays installed. A live update never falls through to quit-and-install. The server recovers when quit-and-install does not quit.

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
