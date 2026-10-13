import { FilterChip } from "../filters/FilterChip";
import { Button } from "../ui/button";
import {
  clearPullRequestFilterChips,
  type PullRequestFilterChip,
} from "./pullRequestFilterChips.logic";
import type { PullRequestListPreferencePatch } from "./pullRequestListPreferences";

/**
 * Fork: the active menu filters above the pull request list, shown while the
 * `pullRequestFilterChips` setting is on. If upstream T3 Code ships its own active-filter chips,
 * drop this fork version and use theirs.
 */
export function PullRequestFilterChips({
  chips,
  onChange,
}: {
  readonly chips: ReadonlyArray<PullRequestFilterChip>;
  readonly onChange: (patch: PullRequestListPreferencePatch) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => {
        const flip = chip.flip;
        return (
          <FilterChip
            key={chip.key}
            field={chip.field}
            operator={chip.operator}
            value={chip.value}
            onFlip={flip ? () => onChange(flip) : undefined}
            onRemove={() => onChange(chip.remove)}
          />
        );
      })}
      {chips.length > 1 ? (
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => onChange(clearPullRequestFilterChips(chips))}
        >
          Clear all
        </Button>
      ) : null}
    </div>
  );
}
