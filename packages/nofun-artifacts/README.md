# @t3tools/nofun-artifacts

Compiles a No Fun spec, TSX file, or page spec into one self-contained HTML document, from a
**clean pinned** `nofun-components` checkout. The pin is `components.pin` (a git sha). `sync --cache`
materializes it at `~/.nofun-t3/caches/nofun-components@<sha>`.

Resolution order:

1. `NOFUN_COMPONENTS_DIR`, when set.
2. The pin cache.
3. An error telling you to run sync.

A dirty checkout, or one whose `HEAD` is not the pin, is refused. `NOFUN_COMPONENTS_ALLOW_DIRTY=1`
compiles it anyway.

## CLI

```sh
node scripts/sync.ts --cache
node src/cli.ts compile \
  --spec examples/dashboard.spec.json \
  --theme kobra \
  --size 960x600 \
  --background transparent \
  --out examples/canvas-out/dashboard
```

`compile` takes exactly one of `--spec`, `--tsx`, or `--page`, plus `--theme`, `--size WxH` (each
side 16–4096), and `--out`. `--background` is `transparent` (the default), `match`, or lowercase
`#rrggbb`. `--name` overrides the title.

`--linked --runtime-sha <sha>` writes a linked bundle instead of a self-contained page. `<sha>` is
the runtime folder under `dist/nofun-ui-runtime/<sha>/` (`pnpm runtime:build`). The HTML loads
`nofun-ui://runtime/<sha>/`. `stamp.json` gains `linked`. `--page` cannot be linked.

The output directory is a Canvas bundle:

| Path               | Role                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`    | Bundle v1. `format` is `nofun-canvas-artifact-bundle`. `sha256` is the hex digest of `index.html`. `source.ref` is `<sha256 of the input file>@components=<commit>`.            |
| `index.html`       | The page. Dark `color-scheme`. `http://` and `https://` are written as `\u002f` escapes so JavaScript still sees them (React's SVG namespace) and the Canvas MCP lint does not. |
| `stamp.json`       | Exactly `components`, `compiler`, `lane`, `theme`, `at`, and `linked` only when set. The meta tag carries the same line without `linked`. `readStamp(html)` parses it.          |
| `source/<file>`    | The input file. `source/meta.json` `file` is this name, relative to `source/`.                                                                                                  |
| `source/meta.json` | `{kind: spec\|tsx\|page, file, theme?}`. `file` stays inside `source/` (no absolute path, no `..`).                                                                             |

Compile failures exit 2 and print the message. The compiler allows a 24 MiB page; Canvas still
rejects an entry over 2 MiB and a bundle over 20 MiB.

`examples/dashboard.spec.json` is the spec-lane fixture. `examples/canvas-out/` is a place to write
bundles; it is not filled in by the package.
