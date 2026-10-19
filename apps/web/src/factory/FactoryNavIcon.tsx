import { FactoryIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";

import { useFactoryAttentionCount } from "./useFactoryData";

/**
 * The sidebar's Factory glyph, with the open attention count at the top-right; hidden at zero.
 * Rendered as a fragment so the svg is the `SidebarMenuButton`'s direct child and takes the same
 * size and colour rules as its neighbours. The badge hangs off a zero-size anchor with no insets,
 * which the button's flex centring puts at the icon's centre whatever the ancestors' positioning,
 * so it is placed from the icon alone. The anchor comes first so the button's
 * `[&>span:last-child]:truncate` misses it.
 */
export function FactoryNavIcon() {
  const count = useFactoryAttentionCount();
  return (
    <>
      {count > 0 ? (
        <span className="pointer-events-none absolute size-0">
          <span className="absolute -top-4 -right-4">
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
