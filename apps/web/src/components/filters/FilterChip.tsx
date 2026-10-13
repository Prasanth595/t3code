import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Fork: how a filter compares. A field with one value per item (an owner, a project) has one
 * operator for the whole filter. A field with many values per item (labels) has one per value.
 */
export type FilterOperator = "is" | "is_not";

export const flipFilterOperator = (operator: FilterOperator): FilterOperator =>
  operator === "is" ? "is_not" : "is";

const operatorLabel = (operator: FilterOperator) => (operator === "is_not" ? "is not" : "is");

/** Fork: a filter as the sentence that its chip reads, such as "Owner is not qlik-trial". */
export function filterSentence(filter: {
  readonly field: string;
  readonly operator: FilterOperator | null;
  readonly value: string;
}): string {
  return filter.operator === null
    ? `${filter.field}: ${filter.value}`
    : `${filter.field} ${operatorLabel(filter.operator)} ${filter.value}`;
}

/**
 * Fork: one active filter, read as a sentence: "Owner is not qlik-trial". The operator is a
 * button when the filter can flip, and the cross removes the filter. A filter without a negative
 * form passes a null operator and reads "Review: approved".
 *
 * An exclusion hides items, so it must stay in view: the pull request page and the sidebar show
 * their active filters with this chip. If upstream T3 Code ships its own active-filter chips,
 * move both callers to those and delete this file.
 */
export function FilterChip({
  field,
  operator,
  value,
  detail,
  alert,
  onFlip,
  onRemove,
}: {
  /** What the filter reads, such as "Owner". */
  readonly field: string;
  readonly operator: FilterOperator | null;
  readonly value: string;
  /** Context after the value, such as "3 projects hidden". */
  readonly detail?: string | undefined;
  /** Hidden items that need the user, such as "2 need you", shown in the warning color. */
  readonly alert?: string | undefined;
  /** Present when the filter can flip between is and is not. */
  readonly onFlip?: (() => void) | undefined;
  readonly onRemove: () => void;
}) {
  const operatorClass = cn(
    "shrink-0 rounded-sm px-0.5 font-medium",
    operator === "is_not" ? "text-warning-foreground" : "text-info-foreground",
  );
  return (
    <span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted pl-2.5 text-xs">
      <span className="shrink-0 text-muted-foreground">
        {operator === null ? `${field}:` : field}
      </span>
      {operator === null ? null : onFlip ? (
        <button
          type="button"
          className={cn(operatorClass, "cursor-pointer hover:bg-accent")}
          aria-label={`Change to "${operatorLabel(flipFilterOperator(operator))}"`}
          onClick={onFlip}
        >
          {operatorLabel(operator)}
        </button>
      ) : (
        <span className={operatorClass}>{operatorLabel(operator)}</span>
      )}
      {/* A long list of values truncates, so the tooltip holds the whole filter. */}
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate text-foreground">{value}</span>}
        />
        <TooltipPopup side="top">{filterSentence({ field, operator, value })}</TooltipPopup>
      </Tooltip>
      {detail ? <span className="shrink-0 text-muted-foreground">· {detail}</span> : null}
      {alert ? (
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-warning-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {alert}
        </span>
      ) : null}
      <Button
        size="icon-micro"
        variant="ghost-muted"
        className="mr-0.5 shrink-0"
        aria-label={`Remove the ${field.toLowerCase()} filter`}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </span>
  );
}
