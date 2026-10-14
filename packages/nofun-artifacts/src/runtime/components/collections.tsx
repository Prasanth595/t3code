// Gallery, Comparison and Timeline.
// - Gallery follows blocks/gallery/caption-mosaic: photo tiles on the brand radius and the accent
//   caption under the image so a long caption wraps instead of clipping inside the tile. No hover zoom.
// - Comparison generalizes blocks/product/compare-table from products to any columns: the Kobra Table
//   with a micro row header on wide frames, stacked cards on narrow ones, plus a "differences only"
//   toggle. Only the first highlighted column takes the accent.
// - Timeline wraps the ported blocks/data/timeline parts. A horizontal timeline becomes vertical
//   under 480px so event titles are not cut off at phone width.
import * as React from "react";

import { Badge } from "@nofun/kobra/badge";
import { Button } from "@nofun/kobra/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nofun/kobra/table";
import {
  Timeline as TimelineRoot,
  TimelineBadge,
  TimelineBody,
  TimelineConnector,
  TimelineContent,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineOpposite,
  TimelineSeparator,
  TimelineTime,
  TimelineTitle,
  type TimelineTone,
} from "@nofun/ui/timeline";
import { cn } from "@nofun/source/lib/utils";
import { IconCheck, IconMinus } from "@tabler/icons-react";
import { ArtifactEmpty, ArtifactLoading } from "./states.tsx";

/* Gallery */

export type GalleryItem = {
  /** An https URL, a data: URI, or an absolute local image path (T3 inlines local images). */
  src: string;
  alt: string;
  caption?: string | undefined;
  href?: string | undefined;
};

export type GalleryProps = {
  items: GalleryItem[];
  columns?: number | undefined;
  aspect?: "square" | "portrait" | "landscape" | undefined;
  emptyText?: string | undefined;
  loading?: boolean | undefined;
  className?: string | undefined;
};

const ASPECT = {
  square: "aspect-square",
  portrait: "aspect-[3/4]",
  landscape: "aspect-[4/3]",
} as const;

export function Gallery({
  items,
  columns = 3,
  aspect = "portrait",
  emptyText = "No images yet.",
  loading = false,
  className,
}: GalleryProps) {
  const cols = Math.max(1, Math.min(4, Math.round(columns)));
  if (loading) return <ArtifactLoading label="Loading images" lines={3} />;
  if (items.length === 0) return <ArtifactEmpty title={emptyText} />;
  return (
    <ul
      data-slot="gallery"
      className={cn("m-0 grid list-none gap-3 p-0", className)}
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, max(150px, calc((100% - ${cols - 1} * 0.75rem) / ${cols}))), 1fr))`,
      }}
    >
      {items.map((item, index) => {
        const image = (
          <div className={cn("relative overflow-hidden", ASPECT[aspect])}>
            <img
              src={item.src}
              alt={item.alt}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 size-full object-cover"
            />
          </div>
        );
        const caption = item.caption ? (
          <span className="micro block wrap-break-word bg-accent-brand p-3 text-[0.66rem] text-accent-brand-foreground">
            <span className="block">{item.caption}</span>
            <span aria-hidden="true" className="mt-4 block h-px w-8 bg-current" />
          </span>
        ) : null;
        const body = (
          <>
            {image}
            {caption}
          </>
        );
        return (
          <li
            key={`${item.src}-${index}`}
            className="grid min-w-0 content-start overflow-hidden rounded-brand bg-surface-product ring-1 ring-foreground/10"
          >
            {item.href ? (
              <a
                href={item.href}
                className="grid outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {body}
              </a>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* Comparison */

export type ComparisonValue = string | number | boolean | null;

export type ComparisonColumn = {
  title: string;
  subtitle?: string | undefined;
  badge?: string | undefined;
  /** Marks the recommended option. */
  highlight?: boolean | undefined;
};

export type ComparisonRow = { label: string; values: ComparisonValue[] };

export type ComparisonProps = {
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
  caption?: string | undefined;
  /** Offer a "Differences only" toggle. Default true when there are more than three rows. */
  diffToggle?: boolean | undefined;
  emptyText?: string | undefined;
  loading?: boolean | undefined;
  className?: string | undefined;
};

function ComparisonCell({ value }: { value: ComparisonValue }) {
  if (value === true)
    return <IconCheck aria-label="Yes" stroke={1.5} className="size-4 text-success" />;
  if (value === false)
    return <IconMinus aria-label="No" stroke={1.5} className="size-4 text-muted-foreground" />;
  if (value === null || value === "") return <span className="text-muted-foreground">—</span>;
  return <>{typeof value === "number" ? value.toLocaleString("en-US") : value}</>;
}

function ColumnHead({ column }: { column: ComparisonColumn }) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 wrap-break-word font-display text-base leading-tight text-foreground [text-transform:var(--nf-display-transform)]">
          {column.title}
        </span>
        {column.badge ? (
          <Badge size="sm" variant={column.highlight ? "default" : "secondary"}>
            {column.badge}
          </Badge>
        ) : null}
      </div>
      {column.subtitle ? (
        <span className="text-sm text-muted-foreground">{column.subtitle}</span>
      ) : null}
    </div>
  );
}

export function Comparison({
  columns,
  rows,
  caption,
  diffToggle,
  emptyText = "Nothing to compare yet.",
  loading = false,
  className,
}: ComparisonProps) {
  const [diffOnly, setDiffOnly] = React.useState(false);
  const highlightIndex = columns.findIndex((column) => column.highlight);
  const marked = columns.map((column, index) => ({
    ...column,
    highlight: index === highlightIndex,
  }));
  const showToggle = diffToggle ?? rows.length > 3;
  const lines = diffOnly
    ? rows.filter((row) => new Set(row.values.map((value) => JSON.stringify(value))).size > 1)
    : rows;
  if (loading) {
    return <ArtifactLoading label={caption ? `Loading ${caption}` : "Loading comparison"} lines={4} />;
  }
  if (rows.length === 0) {
    return (
      <section aria-label={caption ?? "Comparison"} data-slot="comparison" className={className}>
        {caption ? <p className="micro m-0 mb-3 text-muted-foreground">{caption}</p> : null}
        <ArtifactEmpty title={emptyText} />
      </section>
    );
  }
  return (
    <section
      aria-label={caption ?? "Comparison"}
      data-slot="comparison"
      className={cn("@container grid min-w-0 gap-3", className)}
    >
      {caption || showToggle ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {caption ? <p className="micro m-0 text-muted-foreground">{caption}</p> : <span />}
          {showToggle ? (
            <Button
              size="xs"
              variant={diffOnly ? "default" : "outline"}
              aria-pressed={diffOnly}
              onClick={() => setDiffOnly((on) => !on)}
            >
              Differences only
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="hidden @min-[560px]:block">
        <Table aria-label={caption ?? "Comparison"}>
          <TableHeader className="bg-transparent">
            <TableRow>
              <TableHead className="w-36">
                <span className="sr-only">Attribute</span>
              </TableHead>
              {marked.map((column) => (
                <TableHead
                  key={column.title}
                  scope="col"
                  className={cn(
                    "h-auto py-4 align-top whitespace-normal",
                    column.highlight && "bg-accent-brand-soft",
                  )}
                >
                  <ColumnHead column={column} />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((row) => (
              <TableRow key={row.label}>
                <TableHead
                  scope="row"
                  className="micro h-auto py-3 align-top font-normal whitespace-normal text-muted-foreground"
                >
                  {row.label}
                </TableHead>
                {marked.map((column, i) => (
                  <TableCell
                    key={column.title}
                    className={cn(
                      "h-auto py-3 align-top whitespace-normal text-foreground",
                      column.highlight && "bg-accent-brand-soft/60",
                    )}
                  >
                    <ComparisonCell value={row.values[i] ?? null} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="m-0 grid list-none gap-3 p-0 @min-[560px]:hidden">
        {marked.map((column, i) => (
          <li
            key={column.title}
            className={cn(
              "grid gap-3 rounded-brand border border-border p-4",
              column.highlight && "border-foreground/40 bg-accent-brand-soft",
            )}
          >
            <ColumnHead column={column} />
            <dl className="m-0 grid gap-2 border-t border-border pt-3">
              {lines.map((row) => (
                <div key={row.label} className="grid grid-cols-[minmax(0,45%)_minmax(0,1fr)] gap-3 text-sm">
                  <dt className="micro wrap-break-word text-muted-foreground">{row.label}</dt>
                  <dd className="m-0 tabular text-foreground">
                    <ComparisonCell value={row.values[i] ?? null} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Timeline */

export type TimelineEntry = {
  title: string;
  time?: string | undefined;
  body?: string | undefined;
  tone?: TimelineTone | undefined;
  badge?: string | undefined;
  /** Marks the current step. */
  current?: boolean | undefined;
  /** Not happened yet: dashed connector. */
  pending?: boolean | undefined;
};

export type TimelineProps = {
  items: TimelineEntry[];
  orientation?: "vertical" | "horizontal" | undefined;
  /** Put times on the other side of the line (vertical only). */
  opposite?: boolean | undefined;
  size?: "sm" | "default" | "lg" | undefined;
  emptyText?: string | undefined;
  loading?: boolean | undefined;
  className?: string | undefined;
};

export function Timeline({
  items,
  orientation = "vertical",
  opposite = false,
  size = "default",
  emptyText = "No events yet.",
  loading = false,
  className,
}: TimelineProps) {
  const frame = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const resolved =
    orientation === "horizontal" && width > 0 && width < 480 ? "vertical" : orientation;
  const useOpposite = opposite && resolved === "vertical";
  if (loading) return <ArtifactLoading label="Loading events" lines={4} />;
  if (items.length === 0) return <ArtifactEmpty title={emptyText} />;
  return (
    <div ref={frame} data-slot="timeline-frame" className="min-w-0">
      <TimelineRoot orientation={resolved} size={size} className={cn("min-w-0", className)}>
        {items.map((item, index) => (
          <TimelineItem key={`${item.title}-${index}`} current={item.current}>
            {useOpposite && item.time ? <TimelineOpposite>{item.time}</TimelineOpposite> : null}
            <TimelineSeparator>
              <TimelineIndicator tone={item.current ? "primary" : (item.tone ?? "default")} />
              <TimelineConnector
                dashed={item.pending}
                tone={item.pending ? "default" : (item.tone ?? "default")}
              />
            </TimelineSeparator>
            <TimelineContent>
              <TimelineHeader>
                <TimelineTitle className="min-w-0 wrap-break-word">{item.title}</TimelineTitle>
                {item.badge ? (
                  <TimelineBadge tone={item.tone ?? "default"}>{item.badge}</TimelineBadge>
                ) : null}
                {!useOpposite && item.time ? <TimelineTime>{item.time}</TimelineTime> : null}
              </TimelineHeader>
              {item.body ? <TimelineBody>{item.body}</TimelineBody> : null}
            </TimelineContent>
          </TimelineItem>
        ))}
      </TimelineRoot>
    </div>
  );
}
