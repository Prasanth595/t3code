import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/**
 * Fork: why the app token repair (connection/forkAppTokenRepair.ts) cannot reconnect an
 * environment, or null. The environment shows it in place of its connection error.
 */
export const appTokenRepairErrorAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);
