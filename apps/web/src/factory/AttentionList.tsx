import { Link } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import type { FactoryAttentionItem } from "./api";
import { formatAge } from "./format";
import { TouchLink } from "./TouchLink";

/** Where an item leads: its run's page, the factory settings for the machine config, or nowhere. */
function ItemLink({ item }: { item: FactoryAttentionItem }) {
  if (item.run !== null) {
    return (
      <TouchLink render={<Link params={{ runId: item.run }} to="/factory/$runId" />}>
        View run
      </TouchLink>
    );
  }
  if (item.kind === "config") {
    return <TouchLink render={<Link to="/settings/factory" />}>Factory settings</TouchLink>;
  }
  return null;
}

/**
 * The open attention items, newest last as the server sends them; nothing when there are none.
 * `onDismiss` gets the items to dismiss: one, or every item shown for Dismiss all.
 */
export function AttentionList({
  items,
  nowMs,
  onDismiss,
}: {
  items: ReadonlyArray<FactoryAttentionItem>;
  nowMs: number;
  onDismiss: (items: ReadonlyArray<FactoryAttentionItem>) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Needs attention</h2>
        <Button onClick={() => onDismiss(items)} size="sm" variant="ghost">
          Dismiss all
        </Button>
      </div>
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
            <div className="flex items-center justify-between gap-3">
              <ItemLink item={item} />
              <div className="ml-auto">
                <Button onClick={() => onDismiss([item])} size="sm" variant="ghost">
                  Dismiss
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
