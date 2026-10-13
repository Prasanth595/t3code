/* oxlint-disable react/no-array-index-key -- Spreadsheet coordinates are stable, including blank cells. */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import {
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_ROWS,
  SPREADSHEET_PREVIEW_CELL_CHARACTERS,
  SPREADSHEET_PREVIEW_TIMEOUT_MS,
  type SpreadsheetRequest,
  type SpreadsheetResponse,
  type SpreadsheetTable,
} from "./spreadsheetPreviewModel";

export default function SpreadsheetPreview(props: {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly onRetry: () => void;
}) {
  const workerRef = useRef<Worker | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const worksheetId = useId();
  const requestId = useRef(0);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sheets, setSheets] = useState<string[]>([]);
  const [table, setTable] = useState<SpreadsheetTable | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const startWatchdog = useCallback(() => {
    clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      workerRef.current?.terminate();
      workerRef.current = null;
      requestId.current++;
      setPending(false);
      setError("This worksheet took too long to preview. Save it to open it in another app.");
    }, SPREADSHEET_PREVIEW_TIMEOUT_MS);
  }, []);
  const request = (
    message: { type: "sheet"; name: string } | { type: "page"; name: string; page: number },
  ) => {
    setPending(true);
    startWatchdog();
    workerRef.current?.postMessage({
      ...message,
      id: ++requestId.current,
    } satisfies SpreadsheetRequest);
  };
  useEffect(() => {
    // Parsing stays off the chat renderer's main thread. A private copy also survives StrictMode's remount.
    const worker = new Worker(new URL("./spreadsheetPreview.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.addEventListener("message", (event: MessageEvent<SpreadsheetResponse>) => {
      if (event.data.id !== requestId.current) return;
      clearTimeout(watchdog.current);
      setPending(false);
      if ("error" in event.data) {
        setError(event.data.error);
        return;
      }
      const response = event.data;
      setError(null);
      setSheets(response.sheets);
      setSelected(response.table.name);
      setTable(response.table);
      scrollRef.current?.scrollTo({ top: 0 });
    });
    worker.addEventListener("error", () => {
      if (workerRef.current !== worker) return;
      clearTimeout(watchdog.current);
      worker.terminate();
      workerRef.current = null;
      setPending(false);
      setError("Could not render this workbook. Save it to open it in another app.");
    });
    const bytes = props.bytes.slice();
    startWatchdog();
    worker.postMessage(
      { type: "load", id: ++requestId.current, bytes } satisfies SpreadsheetRequest,
      [bytes.buffer],
    );
    return () => {
      clearTimeout(watchdog.current);
      worker.terminate();
      workerRef.current = null;
      requestId.current++;
    };
  }, [props.bytes, startWatchdog]);
  if (error !== null) return <FileSurfaceFailure message={error} onRetry={props.onRetry} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sheets.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
          <label htmlFor={worksheetId}>Worksheet</label>
          <select
            id={worksheetId}
            aria-label="Worksheet"
            value={selected ?? ""}
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
            onChange={(event) => {
              const name = event.target.value;
              setSelected(name);
              setTable(null);
              request({ type: "sheet", name });
            }}
          >
            {sheets.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {table === null ? (
        <FileSurfaceLoading />
      ) : table.rows.length === 0 ? (
        <FileSurfaceNotice>This worksheet is empty.</FileSurfaceNotice>
      ) : (
        <>
          {table.truncated ? (
            <FileSurfaceNotice>
              Preview limited to {SPREADSHEET_PREVIEW_ROWS} rows and {SPREADSHEET_PREVIEW_COLUMNS}{" "}
              columns, with {SPREADSHEET_PREVIEW_CELL_CHARACTERS.toLocaleString()} characters per
              cell. Save the workbook to view the rest.
              {table.contentLimited ? " The preview's total content budget was reached." : ""}
            </FileSurfaceNotice>
          ) : null}
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable_both-edges]"
          >
            <table
              className="min-w-full border-separate border-spacing-0 text-xs"
              aria-label={`${props.name}: ${table.name}`}
            >
              <thead className="sticky top-0 z-10">
                <tr>
                  <th aria-label="Row number" className="border-b bg-muted px-3 py-2" />
                  {table.columns.map((column) => (
                    <th key={column} scope="col" className="border-b bg-muted px-3 py-2 text-left">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.number} className="even:bg-muted/30">
                    <th
                      scope="row"
                      className="sticky left-0 border-b bg-muted px-3 py-1.5 font-normal text-muted-foreground"
                    >
                      {row.number}
                    </th>
                    {row.cells.map((cell, index) => (
                      <td
                        key={index}
                        className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.pageCount > 1 ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-xs">
              <Button
                variant="outline"
                size="sm"
                disabled={pending || table.page === 0}
                onClick={() => request({ type: "page", name: table.name, page: table.page - 1 })}
              >
                Previous page
              </Button>
              <span role="status">
                Page {table.page + 1} of {table.pageCount} · Rows {table.rows[0]?.number}–
                {table.rows.at(-1)?.number}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || table.page + 1 >= table.pageCount}
                onClick={() => request({ type: "page", name: table.name, page: table.page + 1 })}
              >
                Next page
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
