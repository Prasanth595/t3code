import { FactoryIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";

import { useFactoryAttentionCount } from "./useFactoryData";

/**
 * The sidebar's Factory glyph, with the open attention count at the top-right; hidden at zero.
 * Rendered as a fragment so the svg is the `SidebarMenuButton`'s direct child and takes the same
 * size and colour rules as its neighbours. The badge hangs off an anchor with no insets and the
 * icon's `size-4`: an absolute flex child sits where it would as the only item, which is where the
 * svg sits as the first in-flow item, centred or not, so the badge is placed from the icon alone.
 * The anchor comes first so the button's `[&>span:last-child]:truncate` misses it.
 */
export function FactoryNavIcon() {
  const count = useFactoryAttentionCount();
  return (
    <>
      {count > 0 ? (
        <span className="pointer-events-none absolute size-4">
          <span className="absolute -top-1 -right-2 flex">
            <Badge size="sm" variant="destructive">
              {count}
            </Badge>
          </span>
        </span>
      ) : null}
      <FactoryIcon />
    </>
  );
}
