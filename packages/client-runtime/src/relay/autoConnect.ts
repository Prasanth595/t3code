import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";

import { orchestrationProtocolCompatibilityError } from "../connection/compatibility.ts";
import type { RelayDiscoveredEnvironment } from "./discovery.ts";

/**
 * Computers on the account that a signed-in client should add by itself: every compatible one
 * that is not this machine, not saved yet, and not one the user removed after an earlier
 * automatic add.
 */
export function environmentsToAutoConnect(input: {
  readonly discovered: ReadonlyMap<string, RelayDiscoveredEnvironment>;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly localEnvironmentId: string | null;
  readonly previouslyAdded: ReadonlySet<string>;
}): ReadonlyArray<RelayClientEnvironmentRecord> {
  return [...input.discovered.values()].flatMap(({ environment, availability, status }) => {
    const id = environment.environmentId;
    if (
      id === input.localEnvironmentId ||
      input.savedEnvironmentIds.has(id) ||
      input.previouslyAdded.has(id) ||
      availability === "checking"
    ) {
      return [];
    }
    const descriptor = Option.getOrNull(status)?.descriptor;
    if (descriptor !== undefined && orchestrationProtocolCompatibilityError(descriptor) !== null) {
      return [];
    }
    return [environment];
  });
}
