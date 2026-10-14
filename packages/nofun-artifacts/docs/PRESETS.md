# Canvas presets

A preset is the set of defaults that makes an artifact look finished on a Canvas board: the theme, the
card background, the card size for the lane, the dark scheme, and a small frame stylesheet. Pass one to
the CLI instead of `--theme`, `--size` and `--background`; an explicit flag still wins.

```sh
nofun-artifacts compile --spec examples/canvas/dashboard.spec.json --preset canvas-dark-kobra --out dashboard
nofun-artifacts compile --page examples/canvas/brand-page.page.json --preset canvas-dark-kobra --theme mrch --out brand-page
```

Source: [`src/presets.ts`](../src/presets.ts). Samples: [`examples/canvas/`](../examples/canvas/).

## Which preset

| Preset                    | Theme         | Background    | Use it for                                                                                  |
| ------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `canvas-dark-kobra`       | `kobra`       | `transparent` | The default. Data, explainers, anything that should read as content on the board.           |
| `canvas-dark-native-feel` | `native-feel` | `transparent` | Cards that sit beside native No Fun cards and should feel like the Mac app (SF type, blue). |
| `canvas-t3`               | `t3`          | `match`       | No brand at all: the app's neutral tokens, with the board colour painted under the page.    |

For a brand's own work (a brand page, a drop, a merch board), keep the preset and pass `--theme <brand>`.
Pages paint the brand's canvas themselves, so they read as a panel on the board.

## Sizes

1 CSS px is 1 board point, and zooming never reflows the page. Lay the page out for exactly this
viewport.

| Lane   | Default size | Root type size |
| ------ | ------------ | -------------- |
| `spec` | 960 × 600    | 16px           |
| `tsx`  | 640 × 440    | 14.4px         |
| `page` | 1200 × 800   | 16px           |

The root type size is `clamp(14px, 11.2px + 0.5vw, 16px)`: 14px on a 560-wide card, 16px from 960 up.
Everything sized in rem follows it, so a smaller card gets slightly denser type rather than clipping.

## What the frame stylesheet does

All of it is a default with zero specificity, so a component's own styles win.

- Hides scrollbars; content still scrolls.
- Gives text selection and `:focus-visible` a ring in the theme's foreground (native-feel: its accent).
- Turns off overscroll bounce and enables antialiased text.
- Falls back to the system font when a linked artifact's runtime.css was built without Geist. Without
  it the page renders in Times. Standalone artifacts always carry Geist (from `fonts/` when the
  checkout has no next/font build).

## Looks wrong on the board

- **Dark text on a transparent card.** The board is RGB 23/24/26. Use theme tokens (`text-foreground`,
  `text-muted-foreground`), never a fixed colour. The preset pins the dark scheme, so tokens resolve light.
- **Content taller or wider than the card.** The page cannot grow the card. Fit the default size, or pass
  a `--size` that matches the content. A fixed `width` bigger than the card, or a `min-w-*` on a row,
  makes the content clip at the card edge.
- **Empty space under a short layout.** Fill the card (`min-h-[calc(100dvh-32px)]` on the outer frame
  of a tsx artifact) or make the card smaller.
- **Autoplay media and loops.** Marquees, tickers, count-ups and videos repaint every frame. Canvas runs
  six cards at once and pauses hidden ones, so a loop costs GPU on every board. Leave them out, or stop
  them on the `pause` message.
- **Images that never arrive.** The compiler inlines every image a headless render of the page asks
  for, in both schemes and every srcset size, until the page reaches Canvas's 24 MiB `index.html` cap;
  the CLI says how many it left out. A brand page with a product hero and an eight-product grid is
  about 3 MiB. Spec and tsx artifacts are 0.6 to 1 MiB standalone and 4 to 15 KiB linked
  (`--linked --runtime-sha <sha>`).
