import type { MachineRecord } from "@t3tools/contracts/machineMap";

import { usePortalContext } from "./context.ts";
import { machineQueue } from "./derive.ts";
import { AlertStickers } from "./resources.tsx";
import { formatRoute } from "./route.ts";
import { StickerLink } from "./StickerLink.tsx";

/**
 * MM-1003, MM-1113: the work stickers of a machine card and the machine panel. Running and waiting
 * threads open T3 on the machine, alerts open Health, an update opens the machine, and queued work
 * opens the Queue of the machine.
 */
export function MachineStickers({ machine }: { machine: MachineRecord }) {
  const portal = usePortalContext();
  const status = portal.snapshot.presence[machine.id]?.status ?? null;
  const queue = machineQueue(portal.snapshot, portal.rotations, machine);
  const t3 = machine.hostname ? `https://${machine.hostname}` : null;
  const selection = { _tag: "machine", id: machine.id } as const;
  return (
    <>
      <AlertStickers machineId={machine.id} href={formatRoute({ view: "health", selection })} />
      {status && status.runningTurns > 0 && (
        <StickerLink className="sticker ok" href={t3} label={`Open T3 on ${machine.name}`}>
          {status.runningTurns} running
        </StickerLink>
      )}
      {status && status.waitingThreads > 0 && (
        <StickerLink className="sticker wait" href={t3} label={`Open T3 on ${machine.name}`}>
          {status.waitingThreads} {status.waitingThreads === 1 ? "needs" : "need"} you
        </StickerLink>
      )}
      {status?.updateWaiting && (
        <StickerLink
          className="sticker info"
          href={formatRoute({ view: portal.route.view, selection })}
          label={`Update ${status.updateWaiting} waits. Open ${machine.name} to install it.`}
        >
          update
        </StickerLink>
      )}
      {!queue.waitingToJoin && queue.count > 0 && (
        <StickerLink
          className="sticker wait"
          href={formatRoute({ view: "queue", selection })}
          label={`Open the queue of ${machine.name}`}
        >
          {queue.count} queued
        </StickerLink>
      )}
    </>
  );
}
