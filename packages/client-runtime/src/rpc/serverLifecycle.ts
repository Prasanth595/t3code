import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export function shareServerLifecycle<E, R>(
  source: Stream.Stream<ServerLifecycleStreamEvent, E, R>,
) {
  return source.pipe(
    Stream.mapAccumArray(
      () => [] as ReadonlyArray<ServerLifecycleStreamEvent>,
      (snapshot, events) => {
        // Match the server's snapshot: retain the latest event of each type.
        let next = snapshot;
        for (const event of events) {
          next = [...next.filter((entry) => entry.type !== event.type), event];
        }
        next = [...next].sort((left, right) => left.sequence - right.sequence);
        // Replay is measured in chunks, so publish one snapshot per source chunk.
        return [next, [{ events, snapshot: next }]] as const;
      },
    ),
    Stream.share({ capacity: 16, replay: 1 }),
    Effect.map((shared) =>
      shared.pipe(
        // The first replay carries a snapshot; subsequent values are live events.
        Stream.mapAccum(
          () => false,
          (received, { events, snapshot }) => [true, received ? events : snapshot] as const,
        ),
      ),
    ),
  );
}
