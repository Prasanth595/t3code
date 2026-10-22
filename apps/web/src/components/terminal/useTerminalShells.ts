import type { EnvironmentId, TerminalShellProfile } from "@t3tools/contracts";
import { useState } from "react";

import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";

// Detected shells only change when the user installs one, so one fetch per
// environment per session is enough. Keyed by environment because the list is
// detected on that server.
const shellsByEnvironment = new Map<string, readonly TerminalShellProfile[]>();
const inflightByEnvironment = new Map<string, Promise<readonly TerminalShellProfile[] | null>>();

/** Lists the shells detected on `environmentId`; nothing is fetched until `load` runs. */
export function useTerminalShells(environmentId: EnvironmentId | null) {
  const listShells = useAtomCommand(terminalEnvironment.listShells, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly environmentId: string;
    readonly shells: readonly TerminalShellProfile[];
  } | null>(null);

  const cached = environmentId === null ? undefined : shellsByEnvironment.get(environmentId);
  const shells = cached ?? (loaded?.environmentId === environmentId ? loaded.shells : null);

  const load = () => {
    if (environmentId === null || shellsByEnvironment.has(environmentId)) return;
    let pending = inflightByEnvironment.get(environmentId);
    if (!pending) {
      pending = listShells({ environmentId, input: {} }).then((result) => {
        inflightByEnvironment.delete(environmentId);
        if (result._tag !== "Success") return null;
        shellsByEnvironment.set(environmentId, result.value.shells);
        return result.value.shells;
      });
      inflightByEnvironment.set(environmentId, pending);
    }
    void pending.then((next) => {
      if (next) setLoaded({ environmentId, shells: next });
    });
  };

  return { shells, load };
}
