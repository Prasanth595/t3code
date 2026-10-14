# Spec lane review, 2026-10-14

Screenshots render the current spec wrappers against the ported UI from `0189a3199`. The live `nofun-components` checkout is not on this machine, so these are not live Recharts frames. Clips reported by the probe that are only the sr-only strings "Up", "Down", "No data", "Filter rows", and "Attribute" are ignored.

Page overflow was false at 1280 and 390, light and dark, for kobra, mrch, and t3, on both examples, with zero console errors.

| Component | Theme / width | Measured defect | Fix | File |
| --- | --- | --- | --- | --- |
| Stack, Status | kobra, mrch, t3 at 390 | Horizontal stack of a long heading and a nowrap badge grew the page to 467–519px. | Horizontal stacks wrap unless `wrap` is false. Children are `min-w-0` / `max-w-full`. Status badge and detail wrap. | `src/runtime/components/layout.tsx`, `src/runtime/components/metric.tsx` |
| Text, Metric | kobra and mrch, 1280 and 390 | KPI labels truncated (`Share of orders…`, `Median time to first byte…`). | Label and footer wrap. Header grows with the label. Text uses `wrap-break-word`. | `src/runtime/components/metric.tsx`, `src/runtime/components/layout.tsx` |
| Metric | all themes | `loading` was ignored, so the card still showed `$1,200`. | Loading replaces the number with a static skeleton. Null still renders a dash. `0.25` percent renders `25%`. | `src/runtime/components/metric.tsx` |
| Chart | kobra light, edges | Default series order included pale `chart-1`. A requested `chart-1` and `success` would have been drawn as series ink. | Six-slot order is ink, muted, `chart-2`…`chart-5`. `chart-1` and status hues remap to that slot. Index 1 on line/area is dashed unless set. | `src/runtime/components/chart.tsx` |
| Chart | all themes, edges | Empty data ignored `emptyText` and would still call the plot. | Empty data renders "No orders recorded for this week." The plot is not mounted. | `src/runtime/components/chart.tsx`, `src/catalog.ts` |
| DataTable | kobra, dashboard and edges | Whole dollars rendered `$9,360.00` / `$800.00`. An unbroken product name was 455px of nowrap. | Integer currency drops cents (`$9,360`, `$800`). Text cells wrap inside `max-w-48`. The table scroller still owns overflow. | `src/runtime/components/data-table.tsx` |
| Gallery | kobra 390 | Caption was `position: absolute` inside the tile and ended cut off. Hover scaled the photo. | Caption sits under the image and wraps. Hover scale is gone. | `src/runtime/components/collections.tsx` |
| Comparison | kobra 390 | A second `highlight` would have painted two accent columns. Long attribute labels used a fixed 7rem column. | Only the first highlight is accented. Phone rows use `minmax(0, 45%)`. | `src/runtime/components/collections.tsx` |
| Timeline | all themes at 390 | Horizontal orientation kept five events on one axis, so later titles were cut off. | Under 480px a horizontal timeline renders vertical. Titles wrap. At 1280 it stays horizontal. | `src/runtime/components/collections.tsx` |
| Grid, frame | t3 at 390 | t3 had no frame padding, so a `minColumnWidth: 180` grid stayed two columns at 187px and sat flush. t3 also lacked `--nf-accent` and status token maps. | Brand and t3 frames share 16px padding and the 400/700 weight pin. t3 maps No Fun tokens onto the reader theme. 390 grids drop to one column (358px). | `src/compiler.ts` |
| Catalog | spec validation | Chart, gallery, comparison, and timeline rejected empty lists, so empty states could not be authored. | Empty lists are valid. `loading` and `emptyText` are catalog props. Chart `data` stays required. | `src/catalog.ts` |
| Dashboard copy | all themes | Title was the topic ("Studio pulse") and the chart omitted unit, period, and n. | Title is "Revenue up 12% on week 40". Chart description is "USD, weeks 33 to 40, n=8, example data". | `examples/dashboard.spec.json` |

## Open

| Item | Why it is open |
| --- | --- |
| Live chart animation | The live Recharts plots were not imported here. The wrapper does not pass `isAnimationActive` because that prop is unverified. The stand-in SVG plot does not animate, and gallery hover motion is removed. |
| Live bar domain | Stand-in bars start at 0 (dashboard axis `$0`, edges axis `0`). The live plot's domain was not executed. |
| Kobra series contrast | On kobra, muted and `chart-2` are both about `oklch(0.556 0 0)`. mrch `chart-2` is lime and distinct. Token values are left as the theme defines them. |
| Gallery captions | Every caption tile still uses `bg-accent-brand`, which is the caption-mosaic treatment. Comparison is the view limited to one accent. |
| Brand case | mrch titles stay uppercase through `--nf-display-transform`. Micro labels stay on `--nf-micro-transform`. That is the brand token, not a sentence-case miss. |

## Evidence

JPEGs in this directory, 1.5 MB total. Before frames are the same stand-in before these wrapper edits.

- `before-dashboard-kobra-light-390.jpg` / `after-dashboard-kobra-light-390.jpg`
- `before-edges-kobra-light-390.jpg` / `after-edges-kobra-light-390.jpg`
- `after-edges-kobra-dark-390.jpg`
- `after-edges-kobra-dark-1280.jpg`
- `after-edges-mrch-light-390.jpg`
- `after-edges-t3-light-390.jpg`
- `after-edges-t3-dark-1280.jpg`
