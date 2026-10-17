import { FactoryIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";

import { useFactoryAttentionCount } from "./useFactoryData";

/** The sidebar's Factory glyph, with the open attention count at its top-right; hidden at zero. */
export function FactoryNavIcon() {
  const count = useFactoryAttentionCount();
  return (
    <span className="relative inline-flex">
      <FactoryIcon />
      {count > 0 ? (
        <span className="pointer-events-none absolute -top-2 -right-2">
          <Badge size="sm" variant="destructive">
            {count}
          </Badge>
        </span>
      ) : null}
    </span>
  );
}
