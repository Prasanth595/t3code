/* oxlint-disable react/no-array-index-key -- Spreadsheet rows and columns have stable indexed positions. */
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Table, FileSpreadsheet, Layers } from "lucide-react";

import { cn } from "~/lib/utils";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";

const MAX_PREVIEW_ROWS = 1000;
const MAX_PREVIEW_COLS = 50;

interface ExcelPreviewProps {
  readonly name: string;
  readonly src?: string | null | undefined;
  readonly file?: Blob | null | undefined;
  readonly data?: ArrayBuffer | Uint8Array | null | undefined;
  readonly onError?: ((error: Error) => void) | undefined;
}

interface ParsedSheet {
  readonly name: string;
  readonly colHeaders: string[];
  readonly rowHeaders: number[];
  readonly rows: string[][];
  readonly totalRows: number;
  readonly totalCols: number;
  readonly truncatedRows: boolean;
  readonly truncatedCols: boolean;
}

export function ExcelPreview({ name, src, file, data, onError }: ExcelPreviewProps) {
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSheetName, setActiveSheetName] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        let buffer: ArrayBuffer;
        if (data) {
          buffer =
            data instanceof Uint8Array
              ? (data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength,
                ) as ArrayBuffer)
              : data;
        } else if (file) {
          buffer = await file.arrayBuffer();
        } else if (src) {
          const response = await fetch(src, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(`Failed to load file: HTTP ${response.status}`);
          }
          buffer = await response.arrayBuffer();
        } else {
          throw new Error("No source provided for Excel preview.");
        }

        if (cancelled) return;

        const wb = XLSX.read(buffer, { type: "array" });
        if (!wb.SheetNames || wb.SheetNames.length === 0) {
          throw new Error("The workbook contains no sheets.");
        }

        setWorkbook(wb);
        setActiveSheetName(wb.SheetNames[0] ?? "");
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to parse spreadsheet.";
        setError(msg);
        if (err instanceof Error) {
          onError?.(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src, file, data, onError]);

  const parsedSheet = useMemo<ParsedSheet | null>(() => {
    if (!workbook || !activeSheetName) return null;
    const sheet = workbook.Sheets[activeSheetName];
    if (!sheet) return null;

    const ref = sheet["!ref"];
    if (!ref) {
      return {
        name: activeSheetName,
        colHeaders: [],
        rowHeaders: [],
        rows: [],
        totalRows: 0,
        totalCols: 0,
        truncatedRows: false,
        truncatedCols: false,
      };
    }

    const range = XLSX.utils.decode_range(ref);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;

    const visibleRows = Math.min(totalRows, MAX_PREVIEW_ROWS);
    const visibleCols = Math.min(totalCols, MAX_PREVIEW_COLS);

    const colHeaders: string[] = [];
    for (let c = range.s.c; c < range.s.c + visibleCols; c++) {
      colHeaders.push(XLSX.utils.encode_col(c));
    }

    const rowHeaders: number[] = [];
    const rows: string[][] = [];

    for (let r = range.s.r; r < range.s.r + visibleRows; r++) {
      rowHeaders.push(r + 1);
      const row: string[] = [];
      for (let c = range.s.c; c < range.s.c + visibleCols; c++) {
        const cellAddress = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[cellAddress];
        if (cell) {
          const formatted =
            cell.w ?? (cell.v !== undefined && cell.v !== null ? String(cell.v) : "");
          row.push(formatted);
        } else {
          row.push("");
        }
      }
      rows.push(row);
    }

    return {
      name: activeSheetName,
      colHeaders,
      rowHeaders,
      rows,
      totalRows,
      totalCols,
      truncatedRows: totalRows > MAX_PREVIEW_ROWS,
      truncatedCols: totalCols > MAX_PREVIEW_COLS,
    };
  }, [workbook, activeSheetName]);

  if (loading) {
    return <FileSurfaceLoading className="p-8" />;
  }

  if (error || !workbook) {
    return <FileSurfaceFailure message={error ?? "Could not load spreadsheet."} />;
  }

  const sheetNames = workbook.SheetNames;
  const isTruncated = parsedSheet?.truncatedRows || parsedSheet?.truncatedCols;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {isTruncated && (
        <FileSurfaceNotice>
          Spreadsheet view limited to {MAX_PREVIEW_ROWS} rows and {MAX_PREVIEW_COLS} columns.
          {parsedSheet && ` Total size: ${parsedSheet.totalRows} × ${parsedSheet.totalCols}.`}
        </FileSurfaceNotice>
      )}

      {/* Main Table Area */}
      <div className="min-h-0 flex-1 overflow-auto">
        {parsedSheet && parsedSheet.rows.length > 0 ? (
          <table
            className="min-w-full border-separate border-spacing-0 text-xs"
            aria-label={`${name} - ${activeSheetName}`}
          >
            <thead className="sticky top-0 z-10">
              <tr>
                {/* Top-left corner cell */}
                <th
                  scope="col"
                  className="sticky top-0 left-0 z-20 w-12 min-w-12 border-r border-b border-border bg-muted/80 px-2 py-1 text-center font-mono text-2xs text-muted-foreground select-none backdrop-blur"
                >
                  #
                </th>
                {parsedSheet.colHeaders.map((col, idx) => (
                  <th
                    key={idx}
                    scope="col"
                    className="min-w-24 border-r border-b border-border bg-muted/80 px-3 py-1 text-center font-mono text-2xs font-semibold text-muted-foreground select-none backdrop-blur"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsedSheet.rows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-muted/40 even:bg-muted/15">
                  {/* Row number header */}
                  <th
                    scope="row"
                    className="sticky left-0 z-10 w-12 min-w-12 border-r border-b border-border/70 bg-muted/80 px-2 py-1 text-center font-mono text-2xs font-normal text-muted-foreground select-none"
                  >
                    {parsedSheet.rowHeaders[rIdx]}
                  </th>
                  {row.map((cellValue, cIdx) => (
                    <td
                      key={cIdx}
                      className="max-w-96 min-w-24 border-r border-b border-border/50 px-3 py-1 align-top font-sans text-xs whitespace-pre-wrap break-words tabular-nums"
                    >
                      {cellValue}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
            This sheet is empty.
          </div>
        )}
      </div>

      {/* Sheet Tabs Bar at bottom */}
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-border bg-muted/30 px-2">
        <div className="flex items-center gap-1 overflow-x-auto py-1">
          <span className="flex items-center gap-1 px-1.5 text-2xs font-medium text-muted-foreground">
            <Layers className="size-3" />
            Sheets:
          </span>
          {sheetNames.map((sName) => {
            const isActive = sName === activeSheetName;
            return (
              <button
                key={sName}
                type="button"
                onClick={() => setActiveSheetName(sName)}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors select-none",
                  isActive
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <FileSpreadsheet className="size-3 text-emerald-600 dark:text-emerald-400" />
                <span className="max-w-40 truncate">{sName}</span>
              </button>
            );
          })}
        </div>

        {parsedSheet && (
          <div className="shrink-0 px-2 font-mono text-2xs text-muted-foreground">
            {parsedSheet.totalRows.toLocaleString()} rows × {parsedSheet.totalCols.toLocaleString()}{" "}
            cols
          </div>
        )}
      </div>
    </div>
  );
}
