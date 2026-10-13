/* oxlint-disable react/no-array-index-key -- Spreadsheet coordinates are stable, including blank cells. */
import { useEffect, useId, useRef, useState } from "react";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import {
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_ROWS,
  SPREADSHEET_PREVIEW_CELL_CHARACTERS,
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
  const worksheetId = useId();
  const selectedRef = useRef<string | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [table, setTable] = useState<SpreadsheetTable | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Parsing stays off the chat renderer's main thread. A private copy also survives StrictMode's remount.
    const worker = new Worker(new URL("./spreadsheetPreview.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.addEventListener("message", (event: MessageEvent<SpreadsheetResponse>) => {
      if ("error" in event.data) {
        setError(event.data.error);
        return;
      }
      const response = event.data;
      if (selectedRef.current !== null && response.table.name !== selectedRef.current) return;
      selectedRef.current = response.table.name;
      setSheets(response.sheets);
      setSelected(response.table.name);
      setTable(response.table);
    });
    worker.addEventListener("error", () =>
      setError("Could not render this workbook. Save it to open it in another app."),
    );
    const bytes = props.bytes.slice();
    worker.postMessage({ type: "load", bytes } satisfies SpreadsheetRequest, [bytes.buffer]);
    return () => {
      worker.terminate();
      workerRef.current = null;
      selectedRef.current = null;
    };
  }, [props.bytes]);
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
              selectedRef.current = name;
              setSelected(name);
              setTable(null);
              workerRef.current?.postMessage({ type: "sheet", name } satisfies SpreadsheetRequest);
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
            </FileSurfaceNotice>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable_both-edges]">
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
        </>
      )}
    </div>
  );
}
