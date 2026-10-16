/**
 * What the factory reports about itself: the status of the loop (running with the settings the
 * report needs, or idle for a reason).
 */

/** The settings of the machine config the status report shows. */
export interface StatusSettings {
  readonly pollSeconds: number;
  readonly maxConcurrentRuns: number;
  /** The `repo` of every watched repo, `owner/name`. */
  readonly repos: ReadonlyArray<string>;
}

/**
 * What the factory is doing: running, or idle for a reason (no config, or one it cannot read).
 * `running` means the pass loop started; it says nothing about whether passes succeed, which the
 * server log records. The reason names no path and no error, as every reading client gets it;
 * the log has the detail.
 */
export type FactoryStatus =
  | { readonly state: "running"; readonly settings: StatusSettings }
  | { readonly state: "idle"; readonly reason: string };
