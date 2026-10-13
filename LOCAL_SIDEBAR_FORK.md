# Local sidebar project-grouping fork

This checkout adds **By project** inbox grouping (discussion [#7836](https://github.com/pingdotgg/t3code/discussions/7836) / AdEx cut) so every provider's threads appear under their project, with collapsible sections and nested child agents.

It does **not** replace `/Applications/T3 Code (Nightly).app`.

## Develop / launch (macOS)

```sh
cd ~/IdeaProject/t3code
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.local/share/vite-plus/fallback-bin:$PATH"
vp env use 24
vp i
# Never point at live ~/.t3/userdata
vp run dev:desktop --home-dir /tmp/t3code-sidebar-dev
```

Optional: copy a snapshot of your userdata into that home-dir for realistic threads (see `docs/operations/development.md`).

## Checks

```sh
vp run --filter @t3tools/web typecheck
vp test run apps/web/src/components/Sidebar.logic.test.ts
```

## Packaged DMG (optional, does not install)

```sh
vp run dist:desktop:dmg:arm64
```

Install over Nightly only after you explicitly approve.
