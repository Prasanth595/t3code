import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { UsageShareBar } from "./UsageShareBar";
import { reasoningEffortRows } from "./usageBreakdown";

/** The same effort shades and ordering in both cost and usage comparisons. */
export function UsageReasoningBreakdown({ model }: { readonly model: ModelTotals }) {
  const rows = reasoningEffortRows(model);
  if (rows.length === 0) return null;
  const usageValue = (row: (typeof rows)[number]) => row.totalTokens;
  const totalUsage = rows.reduce((sum, row) => sum + usageValue(row), 0);
  const hasPricedCost = rows.some((row) => row.records > row.unpricedRecords);

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Reasoning effort breakdown">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Reasoning effort</h3>
        <span className="text-xs text-muted-foreground">
          {formatCount(model.records)} responses
        </span>
      </div>
      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {hasPricedCost ? (
          <UsageShareBar
            label="Cost by effort"
            segments={rows.map((row) => ({
              label: row.label,
              color: row.color,
              value: row.costUsd,
            }))}
            format={formatUsd}
          />
        ) : null}
        <UsageShareBar
          label="Tokens by effort"
          segments={rows.map((row) => ({
            label: row.label,
            color: row.color,
            value: usageValue(row),
          }))}
          format={formatTokens}
          aside={<span className="text-xs text-muted-foreground">Processed tokens</span>}
        />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th scope="col" className="px-3 py-2.5 text-left font-normal">
                Effort
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-normal">
                Cost
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-normal">
                Processed tokens
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-normal">
                Responses
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.effort} className="border-b border-border/40 last:border-0">
                <th scope="row" className="px-3 py-2.5 text-left font-medium text-foreground">
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-xs"
                      style={{ backgroundColor: row.color }}
                    />
                    {row.label}
                  </span>
                </th>
                <td className="px-3 py-2.5 text-right">
                  <div className="text-foreground">
                    {row.unpricedRecords === row.records ? "Unpriced" : formatUsd(row.costUsd)}
                  </div>
                  {row.unpricedRecords < row.records ? (
                    <div className="mt-0.5 text-muted-foreground">
                      {formatPercent(model.costUsd > 0 ? row.costUsd / model.costUsd : 0)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="text-foreground">{formatTokens(usageValue(row))}</div>
                  <div className="mt-0.5 text-muted-foreground">
                    {formatPercent(totalUsage > 0 ? usageValue(row) / totalUsage : 0)}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">
                  {formatCount(row.records)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((row) => row.effort === "unknown") ? (
        <p className="text-xs text-muted-foreground">
          Unknown includes history where the reasoning effort wasn’t recorded. Usage and cost stay
          included.
        </p>
      ) : null}
      {rows.some((row) => row.unpricedRecords > 0 && row.unpricedRecords < row.records) ? (
        <p className="text-xs text-muted-foreground">
          Cost shares include priced responses only. Some responses have no known price.
        </p>
      ) : null}
    </section>
  );
}
