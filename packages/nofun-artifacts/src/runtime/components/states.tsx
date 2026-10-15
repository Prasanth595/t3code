// Quiet empty and loading states for the spec components. Skeletons do not shimmer:
// artifacts are glanced at, and a looping sweep repaints on high-refresh displays.
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@nofun/kobra/empty";
import { Skeleton } from "@nofun/kobra/skeleton";

export function ArtifactEmpty({ title, detail }: { title: string; detail?: string | undefined }) {
  return (
    <Empty className="border border-border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {detail ? <EmptyDescription>{detail}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

export function ArtifactLoading({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="grid gap-2">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" style={{ animation: "none" }} />
      ))}
    </div>
  );
}
