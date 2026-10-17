import { Badge } from "~/components/ui/badge";

import type { FactoryAttentionItem } from "./api";
import { formatAge } from "./format";

/** The open attention items, newest last as the server sends them; nothing when there are none. */
export function AttentionList({
  items,
  nowMs,
}: {
  items: ReadonlyArray<FactoryAttentionItem>;
  nowMs: number;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Needs attention</h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm"
            key={item.id}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge variant="warning">{item.kind}</Badge>
              {item.repo ? (
                <span className="min-w-0 break-all font-mono text-xs">
                  {item.repo}
                  {item.issue !== null ? `#${item.issue}` : null}
                </span>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {formatAge(Date.parse(item.first_seen), nowMs)}
              </span>
            </div>
            <p className="w-full break-words">{item.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
