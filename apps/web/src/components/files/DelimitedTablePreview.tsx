/* oxlint-disable react/no-array-index-key -- Table rows and columns have stable positions and may contain identical values. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { useMemo } from "react";

import { px0Table } from "~/state/projects";

import { FileSurfaceNotice } from "./fileSurfaceChrome";

/** A bounded, readable table for CSV and TSV text; the source view keeps every byte. */
export function DelimitedTablePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly delimiter: "," | "\t";
  readonly environmentId?: EnvironmentId;
  readonly cwd?: string;
  readonly path?: string;
}) {
  const fallback = useMemo(
    () => parseDelimitedPreview(props.text, props.delimiter),
    [props.text, props.delimiter],
  );
  if (props.environmentId && props.cwd && props.path) {
    return (
      <WorkspaceTable
        name={props.name}
        environmentId={props.environmentId}
        cwd={props.cwd}
        path={props.path}
        fallback={fallback}
      />
    );
  }
  return (
    <TableView
      name={props.name}
      header={fallback.rows[0] ?? []}
      body={fallback.rows.slice(1).map((cells, index) => ({ line: index + 2, cells }))}
      truncated={fallback.truncated}
    />
  );
}

function WorkspaceTable(props: {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly fallback: ReturnType<typeof parseDelimitedPreview>;
}) {
  const tableResult = useAtomValue(
    px0Table({ environmentId: props.environmentId, input: { cwd: props.cwd, path: props.path } }),
  );
  const px0Data = Option.getOrNull(AsyncResult.value(tableResult));
  return (
    <TableView
      name={props.name}
      header={px0Data?.header ?? props.fallback.rows[0] ?? []}
      body={
        px0Data?.rows ??
        props.fallback.rows.slice(1).map((cells, index) => ({ line: index + 2, cells }))
      }
      headerLine={px0Data?.headerLine ?? 1}
      truncated={px0Data?.truncated ?? props.fallback.truncated}
      px0={px0Data !== null}
    />
  );
}

function TableView(props: {
  readonly name: string;
  readonly header: readonly string[];
  readonly headerLine?: number;
  readonly body: ReadonlyArray<{ readonly line: number; readonly cells: readonly string[] }>;
  readonly truncated: boolean;
  readonly px0?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.truncated ? (
        <FileSurfaceNotice>
          {props.px0
            ? "Table preview is limited to 1,000 rows or 1 MB. Switch to source for the rest."
            : "Table limited to the first 100 rows and 30 columns. Switch to source for the rest."}
        </FileSurfaceNotice>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="min-w-full border-separate border-spacing-0 text-xs"
          aria-label={props.name}
        >
          {props.header.length > 0 ? (
            <thead className="sticky top-0 z-10">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 border-b border-border bg-muted/60 px-2 text-right font-mono text-muted-foreground tabular-nums"
                  aria-label="Line number"
                >
                  {props.headerLine ?? ""}
                </th>
                {props.header.map((cell, columnIndex) => (
                  <th
                    key={columnIndex}
                    scope="col"
                    className="max-w-80 border-b border-border bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words backdrop-blur"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {props.body.map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-muted/30">
                <td className="sticky left-0 border-b border-border/60 bg-background px-2 text-right font-mono text-muted-foreground tabular-nums">
                  {row.line}
                </td>
                {row.cells.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
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
    </div>
  );
}
