# No Fun UI runtime

One prebuilt copy of every No Fun block, shipped once per nofun-components revision, so an artifact
on a Canvas board carries only its own code (a linked artifact is ~5 to 15 KiB instead of ~1 MiB).

## Contract

`pnpm runtime:build` (`src/runtime-bundle/build.ts`) reads `NOFUN_COMPONENTS_DIR` (a clean checkout;
`--allow-dirty` stamps a dirty one with its source hash) and writes
`dist/nofun-ui-runtime/<sha>/`, where `<sha>` is the first 12 characters of the checkout's HEAD:

| File              | What                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.js`      | Classic script (IIFE). Defines `window.NoFunUI`.                                                                                                                     |
| `runtime.css`     | Tailwind v4 over every bundled source, Geist inlined, no brand.                                                                                                      |
| `brands/<id>.css` | One brand's tokens, scoped to `[data-brand="<id>"]`, with its fonts inlined.                                                                                         |
| `manifest.json`   | `sha`, `componentsCommit`, `builtAt`, `itemCount`, `moduleCount`, `componentCount`, `sizes`, `brands` (schemes), `excluded` (with reasons), `modules`, `components`. |

`window.NoFunUI`:

- `version`: the `<sha>`.
- `components[name]`: the main component of every registry block and component (commerce included),
  and `components["kobra/<name>"]` for every Kobra primitive.
- `modules[specifier]`: whole modules by import specifier: `@nofun/ui/<name>`, `@nofun/ui/<name>/demo`,
  `@nofun/kobra/<name>`, `@nofun/artifacts`, and `react`, `react/jsx-runtime`, `react-dom`,
  `react-dom/client`, `motion`, `motion/react`, `recharts`, `@tabler/icons-react`.
- `require(specifier)`: a module as a linked chunk imports it; throws naming the runtime when absent.
- `mount(el, input)`: renders a component, a module with a default export, or a catalog spec
  (`{ root }`), inside the artifact error boundary. Returns `{ unmount }`.
- `theme(id, { el?, scheme? })`: scopes `el` (default `<body>`) to a brand and loads
  `brands/<id>.css` beside `runtime.js`. `t3` or `null` clears it.

A module that does not bundle is left out and listed in `manifest.excluded`. Block-internal files
(anything under a block other than `/demo`) are not in the runtime.

## Sizes

Budget: what one page loads (`runtime.js` + `runtime.css` + one brand) stays under 24 MiB; the build
exits non-zero over it. At nofun-components `8922135e`: `runtime.js` 15.16 MiB, `runtime.css`
0.93 MiB, largest brand 0.36 MiB, so a page loads 16.45 MiB. All 58 brands add 10.07 MiB, so the folder
is 26.17 MiB. Tabler icons (2.9 MiB) and Recharts (0.6 MiB) are the largest packages.

## Linked artifacts

`compileLinked({ lane, source, theme, size, runtimeSHA })` in `src/linked.ts` returns HTML that
loads `nofun-ui://runtime/<sha>/runtime.js`, `runtime.css` and the theme's brand sheet, then mounts:

- tsx: the user module bundled on its own, every import pointed at `NoFunUI.require`, plus the
  Tailwind utilities its classes need that `runtime.css` lacks.
- spec: the spec JSON only.

The stamp is `<meta name="nofun-artifact" content="components=<sha>;lane=…;theme=…;size=WxH;at=…;linked=<sha>">`.
When `dist/nofun-ui-runtime/<sha>/` is on disk, imports the runtime lacks fail at compile time.

## How Canvas consumes it

Canvas ships `nofun-ui-runtime/<sha>/` as an app resource and serves it at
`nofun-ui://runtime/<sha>/<file>`, and the artifact itself at `nofun-card://<id>/`. Everything is
local and loads with classic scripts. A linked page names its runtime in the stamp's `linked=`, so
Canvas can keep several runtimes side by side and tell which one a card needs. `runtimeBase` swaps
the scheme for a relative path: `examples/linked-check.html` loads
`../dist/nofun-ui-runtime/<sha>/` in a plain browser or a WKWebView with read access to the package
folder (`node examples/linked-check.ts [<sha>] [--shot <png>]` regenerates it).

## Selecting a brand

The page body carries `data-brand="<id>"` and the page links only that brand's sheet. Single-scheme
brands also get `data-nf-scheme` (and `.dark` when dark). Two-scheme brands follow the system
appearance unless `scheme` pins one (`compileLinked({ scheme })` or `NoFunUI.theme(id, { scheme })`).
Switching brands at runtime is one `NoFunUI.theme(id)` call; it loads the new sheet on first use.
