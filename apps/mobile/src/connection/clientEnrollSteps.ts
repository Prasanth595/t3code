/**
 * Fork: the steps of a portal invite (MM-913), free of React Native imports so that tests can
 * run them. `clientEnroll.ts` holds the network calls, and `useClientEnroll.ts` passes them in.
 */
import type { ClientEnrollResponse } from "@t3tools/contracts";

import type { ClientInvite } from "./clientEnroll";

export interface ClientEnrollResult {
  readonly name: string;
  readonly paired: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/**
 * The steps of an invite, with the effects passed in. The redeemed token is the only copy, so
 * the enrollment rolls back only when saving it fails. A machine that does not pair stays
 * listed in the portal, and the app token repair pairs it later (forkAppTokenRepair.ts).
 */
export async function enrollWithInvite(
  invite: ClientInvite,
  deps: {
    readonly redeem: (invite: ClientInvite) => Promise<ClientEnrollResponse>;
    /** The origin of a URL, or null for an invalid URL. */
    readonly origin: (url: string) => string | null;
    readonly saveToken: (
      origin: string,
      token: ClientEnrollResponse["serviceToken"],
    ) => Promise<{ readonly undo: () => Promise<string | null> } | { readonly error: string }>;
    readonly saveClient: (client: {
      readonly machinesUrl: string;
      readonly clientId: string;
    }) => void;
    /** Pairs with one machine; throws with the reason when it fails. */
    readonly pair: (machine: ClientEnrollResponse["machines"][number]) => Promise<void>;
  },
): Promise<ClientEnrollResult> {
  const enrolled = await deps.redeem(invite);
  const portalOrigin = deps.origin(enrolled.machinesUrl);
  if (portalOrigin === null) throw new Error("The portal sent an invalid machine list URL.");
  // The portal origin keeps the token for the machine list (MM-914).
  const origins = new Set(
    [portalOrigin, ...enrolled.machines.map((machine) => deps.origin(machine.origin))].filter(
      (origin): origin is string => origin !== null,
    ),
  );
  const undos: Array<() => Promise<string | null>> = [];
  for (const origin of origins) {
    const saved = await deps.saveToken(origin, enrolled.serviceToken);
    if ("error" in saved) {
      const undoErrors: string[] = [];
      for (const undo of undos) {
        const error = await undo();
        if (error) undoErrors.push(error);
      }
      throw new Error([saved.error, ...undoErrors].join("\n"));
    }
    undos.push(saved.undo);
  }
  deps.saveClient({ machinesUrl: enrolled.machinesUrl, clientId: enrolled.clientId });

  const paired: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const machine of enrolled.machines) {
    try {
      await deps.pair(machine);
      paired.push(machine.name);
    } catch (cause) {
      failed.push({
        name: machine.name,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { name: enrolled.name, paired, failed };
}
