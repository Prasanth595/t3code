import { cn } from "~/lib/utils";

/**
 * Marks which environment a run belongs to: a solid dot for the environment picked in the belt, a
 * ring for the others, as the tiles are solid and hollow.
 */
export function BeltDot({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        selected ? "bg-foreground" : "border-2 border-muted-foreground",
      )}
    />
  );
}
