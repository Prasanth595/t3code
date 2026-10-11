import type { ProviderDriverKind } from "@t3tools/contracts";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Latest version reported by the installer that owns the executable.
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know.
   */
  readonly latestVersion?: string | null;
  /** Compare native release revisions when the provider does not use plain semver. */
  readonly compareVersions?: (current: string, latest: string) => number;
  /**
   * The executable T3 Code runs, symlinks followed, when no update command is
   * proven for it. The version advisory names it so the user knows which
   * install to update.
   */
  readonly installPath?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /**
   * Extra environment for the spawned updater, on top of the server's own.
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
}
