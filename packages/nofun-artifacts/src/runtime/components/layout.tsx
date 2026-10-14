// Stack, Grid and Text: thin layout and type wrappers over No Fun tokens. They are new code (No Fun
// lays pages out with raw Tailwind), using the registry's display-m / micro utilities and the brand's
// display transform and weight from registry/nofun-ui/themes/base.css.
import * as React from "react";

import { cn } from "@nofun/source/lib/utils";

const GAP = { none: "0px", sm: "0.5rem", md: "1rem", lg: "1.5rem", xl: "2.5rem" } as const;
export type Gap = keyof typeof GAP;

export type StackProps = {
  direction?: "vertical" | "horizontal" | undefined;
  gap?: Gap | undefined;
  align?: "start" | "center" | "end" | "stretch" | "baseline" | undefined;
  justify?: "start" | "center" | "end" | "between" | undefined;
  wrap?: boolean | undefined;
  className?: string | undefined;
  children?: React.ReactNode;
};

const ALIGN = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};
const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
};

export function Stack({
  direction = "vertical",
  gap = "md",
  align,
  justify,
  wrap,
  className,
  children,
}: StackProps) {
  // A horizontal row wraps unless the spec opts out. Nowrap flex items keep their min-content
  // width, which is how a long heading beside a badge grew the page past 390.
  const wraps = wrap ?? direction === "horizontal";
  return (
    <div
      data-slot="stack"
      className={cn(
        "flex min-w-0 [&>*]:min-w-0 [&>*]:max-w-full",
        direction === "vertical" ? "flex-col" : "flex-row",
        wraps && "flex-wrap",
        className,
      )}
      style={{
        gap: GAP[gap],
        alignItems: align ? ALIGN[align] : direction === "vertical" ? "stretch" : "center",
        justifyContent: justify ? JUSTIFY[justify] : undefined,
      }}
    >
      {children}
    </div>
  );
}

export type GridProps = {
  /** Columns at full width. The grid drops columns as the frame narrows (each keeps `minColumnWidth`). */
  columns?: number | undefined;
  minColumnWidth?: number | undefined;
  gap?: Gap | undefined;
  className?: string | undefined;
  children?: React.ReactNode;
};

const GAP_PX = { none: 0, sm: 8, md: 16, lg: 24, xl: 40 } as const;

/** The most columns that fit, minus one when that would leave a single card alone on the last row. */
function balancedColumns(width: number, max: number, min: number, gap: number, count: number) {
  let fit = Math.max(1, Math.min(max, Math.floor((width + gap) / (min + gap))));
  if (count > 0) fit = Math.min(fit, count);
  if (fit > 2 && count % fit === 1 && count % (fit - 1) !== 1) return fit - 1;
  return fit;
}

export function Grid({
  columns = 2,
  minColumnWidth = 200,
  gap = "md",
  className,
  children,
}: GridProps) {
  const cols = Math.max(1, Math.min(6, Math.round(columns)));
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const count = React.Children.count(children);
  // Until measured, CSS picks the count; then the grid balances rows so no card sits alone.
  const template =
    width > 0
      ? `repeat(${balancedColumns(width, cols, minColumnWidth, GAP_PX[gap], count)}, minmax(0, 1fr))`
      : `repeat(auto-fill, minmax(min(100%, max(${minColumnWidth}px, calc((100% - (var(--cols) - 1) * var(--gap)) / var(--cols)))), 1fr))`;
  return (
    <div
      ref={ref}
      data-slot="grid"
      className={cn("grid min-w-0 [&>*]:min-w-0", className)}
      style={
        {
          gap: GAP[gap],
          "--cols": cols,
          "--gap": GAP[gap],
          gridTemplateColumns: template,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

const TEXT = {
  display: "display-m text-foreground",
  title:
    "font-display text-2xl leading-tight tracking-tight text-foreground font-display-weight [text-transform:var(--nf-display-transform)]",
  heading: "text-base leading-snug font-semibold text-foreground",
  body: "text-sm leading-relaxed text-pretty text-foreground",
  muted: "text-sm leading-relaxed text-pretty text-muted-foreground",
  micro: "micro text-muted-foreground",
} as const;
export type TextVariant = keyof typeof TEXT;

const TAG: Record<TextVariant, "h1" | "h2" | "h3" | "p"> = {
  display: "h1",
  title: "h2",
  heading: "h3",
  body: "p",
  muted: "p",
  micro: "p",
};

export type TextProps = {
  variant?: TextVariant | undefined;
  text?: string | undefined;
  align?: "start" | "center" | "end" | undefined;
  className?: string | undefined;
  children?: React.ReactNode;
};

export function Text({ variant = "body", text, align, className, children }: TextProps) {
  const Tag = TAG[variant];
  return (
    <Tag
      data-slot="text"
      data-variant={variant}
      className={cn("m-0 min-w-0 wrap-break-word", TEXT[variant], className)}
      style={align ? { textAlign: align } : undefined}
    >
      {children ?? text}
    </Tag>
  );
}
