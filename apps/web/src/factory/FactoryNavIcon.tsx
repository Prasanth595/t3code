import { FactoryIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";

import { useFactoryAttentionCount } from "./useFactoryData";

/**
 * The sidebar's Factory glyph, with the open attention count at the top-right; hidden at zero.
 * Rendered as a fragment so the svg is the `SidebarMenuButton`'s direct child and takes the same
 * size and colour rules as its neighbours. The badge is placed against the enclosing
 * `SidebarMenuItem` (`relative`), so the button's `overflow-hidden` cannot clip it, and comes
 * first so the button's `[&>span:last-child]:truncate` misses it.
 */
export function FactoryNavIcon() {
  const count = useFactoryAttentionCount();
  return (
    <>
      {count > 0 ? (
        <span className="pointer-events-none absolute top-0 right-0">
          <Badge size="sm" variant="destructive">
            {count}
          </Badge>
        </span>
      ) : null}
      <FactoryIcon />
    </>
  );
}
