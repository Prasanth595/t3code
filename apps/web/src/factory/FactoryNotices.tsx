import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";

/** What a page shows while its first read is in flight. */
export function FactoryLoading({ label }: { label: string }) {
  return (
    <div aria-label={label} className="flex flex-col gap-3" role="status">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/** A read that failed: what the server (or the network) said, and a way to try again. */
export function FactoryError({
  title = "Could not load the factory",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      ) : null}
    </Empty>
  );
}
