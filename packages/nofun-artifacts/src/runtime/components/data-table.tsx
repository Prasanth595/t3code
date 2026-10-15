// DataTable: the ported Kobra Table (components/ui/table.tsx) with the sort-header affordance of the
// No Fun data-grid block (blocks/data/data-grid: arrow up/down on the active column, numbers aligned
// end) and a Kobra Input filter. Sorting and filtering stay local to the page.
import * as React from "react";

import { Button } from "@nofun/kobra/button";
import { Input } from "@nofun/kobra/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nofun/kobra/table";
import { cn } from "@nofun/source/lib/utils";
import { formatNumberValue } from "@nofun/ui/number-value/format";
import { IconArrowDown, IconArrowUp, IconSearch, IconSelector } from "@tabler/icons-react";
import { Status, type StatusTone } from "./metric.tsx";
import { ArtifactLoading } from "./states.tsx";

export type CellValue = string | number | boolean | null;

export type DataTableColumn = {
  key: string;
  label: string;
  align?: "start" | "center" | "end" | undefined;
  format?: "text" | "number" | "currency" | "percent" | "compact" | "status" | undefined;
  currency?: string | undefined;
  /** For `format: "status"`: the tone each cell value maps to. Unlisted values are neutral. */
  tones?: Record<string, StatusTone> | undefined;
};

export type DataTableProps = {
  columns: DataTableColumn[];
  rows: Array<Record<string, CellValue>>;
  caption?: string | undefined;
  sortable?: boolean | undefined;
  /** Shows a search box that filters rows by any cell's text. */
  filterable?: boolean | undefined;
  /** Rows shown before a "Show all" button. */
  maxRows?: number | undefined;
  emptyText?: string | undefined;
  /** Static skeleton in place of the rows. */
  loading?: boolean | undefined;
  className?: string | undefined;
};

const NUMERIC = new Set(["number", "currency", "percent", "compact"]);

function renderCell(column: DataTableColumn, value: CellValue) {
  if (value === null || value === undefined || value === "")
    return <span className="text-muted-foreground">—</span>;
  const format = column.format ?? (typeof value === "number" ? "number" : "text");
  if (format === "status") {
    const label = String(value);
    return <Status label={label} tone={column.tones?.[label] ?? "neutral"} size="sm" />;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && NUMERIC.has(format)) {
    const wholeCurrency = format === "currency" && Number.isInteger(value);
    return formatNumberValue(value, {
      format: format === "number" ? "decimal" : (format as "currency" | "percent" | "compact"),
      currency: column.currency,
      minimumFractionDigits: wholeCurrency ? 0 : undefined,
      maximumFractionDigits: format === "percent" ? 1 : wholeCurrency ? 0 : 2,
    });
  }
  return String(value);
}

function compare(a: CellValue, b: CellValue) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function DataTable({
  columns,
  rows,
  caption,
  sortable = true,
  filterable = false,
  maxRows,
  emptyText = "No rows match.",
  loading = false,
  className,
}: DataTableProps) {
  const [sort, setSort] = React.useState<{ key: string; desc: boolean } | null>(null);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) =>
          columns.some((c) =>
            String(row[c.key] ?? "")
              .toLowerCase()
              .includes(needle),
          ),
        )
      : rows;
    if (!sort) return filtered;
    const sorted = filtered.toSorted((a, b) => compare(a[sort.key] ?? null, b[sort.key] ?? null));
    return sort.desc ? sorted.toReversed() : sorted;
  }, [columns, query, rows, sort]);

  const limit = maxRows && !expanded ? maxRows : Infinity;
  const shown = visible.slice(0, limit);

  const toggle = (key: string) =>
    setSort((current) =>
      current?.key !== key ? { key, desc: false } : current.desc ? null : { key, desc: true },
    );

  if (loading) {
    return (
      <div data-slot="data-table" className={cn("grid min-w-0 max-w-full gap-3", className)}>
        {caption ? <p className="m-0 text-sm text-foreground">{caption}</p> : null}
        <ArtifactLoading label={caption ? `Loading ${caption}` : "Loading rows"} lines={4} />
      </div>
    );
  }

  return (
    <div data-slot="data-table" className={cn("grid min-w-0 max-w-full gap-3", className)}>
      {caption || filterable ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {caption ? (
            <p className="m-0 text-sm font-medium text-foreground">{caption}</p>
          ) : (
            <span />
          )}
          {filterable ? (
            <label className="relative block w-full max-w-64">
              <span className="sr-only">Filter rows</span>
              <IconSearch
                aria-hidden
                stroke={1.5}
                className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={query}
                placeholder="Filter rows"
                className="ps-8"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setExpanded(false);
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      <Table aria-label={caption}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => {
              const align = column.align ?? (NUMERIC.has(column.format ?? "") ? "end" : "start");
              const active = sort?.key === column.key;
              return (
                <TableHead
                  key={column.key}
                  aria-sort={active ? (sort.desc ? "descending" : "ascending") : undefined}
                  className={cn(align === "end" && "text-end", align === "center" && "text-center")}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggle(column.key)}
                      className={cn(
                        "-mx-1 inline-flex items-center gap-1 rounded-md px-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                        active ? "text-foreground" : "text-foreground/80",
                        align === "end" && "flex-row-reverse",
                      )}
                    >
                      {column.label}
                      {active ? (
                        sort.desc ? (
                          <IconArrowDown aria-hidden stroke={1.5} className="size-3.5" />
                        ) : (
                          <IconArrowUp aria-hidden stroke={1.5} className="size-3.5" />
                        )
                      ) : (
                        <IconSelector
                          aria-hidden
                          stroke={1.5}
                          className="size-3.5 text-muted-foreground/70"
                        />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-16 text-center text-muted-foreground"
              >
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            shown.map((row, index) => (
              <TableRow key={index}>
                {columns.map((column) => {
                  const align =
                    column.align ?? (NUMERIC.has(column.format ?? "") ? "end" : "start");
                  const textual = !NUMERIC.has(column.format ?? "") && column.format !== "status";
                  return (
                    <TableCell
                      key={column.key}
                      className={cn(
                        align === "end" && "text-end",
                        align === "center" && "text-center",
                        textual && "max-w-48 whitespace-normal wrap-break-word",
                      )}
                    >
                      {renderCell(column, row[column.key] ?? null)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {visible.length > shown.length || (expanded && maxRows && visible.length > maxRows) ? (
        <div>
          <Button size="sm" variant="outline" onClick={() => setExpanded((open) => !open)}>
            {expanded ? "Show fewer" : `Show all ${visible.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
