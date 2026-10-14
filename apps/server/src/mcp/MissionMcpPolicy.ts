import {
  EnvironmentId,
  ProjectId,
  TeamId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto needs an Effect context, but the publisher id is minted synchronously in the constructor.
import * as NodeCrypto from "node:crypto";

import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpService from "./MissionMcpService.ts";

/**
 * Local synchronous atomically published producer for the trusted mission MCP
 * policy. Root owns production composition and activation; this module only
 * builds the controller plus its policy service. It wires no default layer,
 * no MCP toolkit route, and no public caller route.
 *
 * Root composition usage (root-owned, NOT wired here):
 *   const controller = new MissionMcpPolicyPublisher();
 *   ...Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, controller.policy)
 * The policy stays disabled until root explicitly publishes a trusted server
 * configuration. There is no activation or default configuration in this module.
 */

/** Shared bound for both allow-lists: at most 64 unique ids each. */
export const MAX_POLICY_LIST_IDS = 64;

/** Bounded fixed rejection: never echoes any submitted configuration. */
const REJECTED_MESSAGE = "The trusted mission policy update was rejected.";

export class MissionMcpPolicyError extends Error {
  readonly _tag = "MissionMcpPolicyError";
  constructor() {
    super(REJECTED_MESSAGE);
    this.name = "MissionMcpPolicyError";
  }
}

/**
 * Strictly decoded root configuration input. Deliberately has NO revision and
 * NO enabled field: any supplied revision, enabled flag, or other excess key
 * is rejected. Company/team/environment/project/bootstrap values must be
 * explicit and nonempty here; schema validation of these fields does NOT
 * itself establish authorization — root authorization and config loading
 * remain root work, and nothing is ever inferred from paths, repos,
 * providers, personas, or account bridges.
 */
const RootTrustedPolicyConfig = Schema.Struct({
  company: Schema.Literal("nofun"),
  companyVerified: Schema.Literal(true),
  bindingVerified: Schema.Literal(true),
  policyRef: TrimmedNonEmptyString,
  teamId: TeamId,
  environmentId: EnvironmentId,
  allowedProjectIds: Schema.Array(ProjectId),
  bootstrapControllerThreadIds: Schema.Array(ThreadId),
});
export type RootTrustedPolicyConfig = typeof RootTrustedPolicyConfig.Type;

const decodeConfig = Schema.decodeUnknownSync(RootTrustedPolicyConfig, {
  onExcessProperty: "error",
});
const decodePublished = Schema.decodeUnknownSync(MissionMcpAuthority.TrustedNoFunMissionPolicy, {
  onExcessProperty: "error",
});

export type PublishedMissionMcpPolicy = MissionMcpAuthority.TrustedNoFunMissionPolicy;

/** Disabled snapshot: bounded data the real resolver already rejects. */
interface DisabledPolicySnapshot {
  readonly enabled: false;
  readonly revision: string;
}

/** Detach from caller-mutable memory through a canonical serialization. */
const detach = <A>(value: A): A => JSON.parse(stableStringify(value)) as A;

const deepFreeze = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
};

const freezeDetached = <A extends object>(value: A): A => {
  const snapshot = detach(value);
  deepFreeze(snapshot);
  return snapshot;
};

const hasDuplicates = (ids: ReadonlyArray<unknown>): boolean =>
  new Set(ids).size !== ids.length;

/**
 * Consistency constraints (also relied on by MissionMcpAuthority):
 * - `read` always returns the same snapshot content as `current` (identical
 *   stable stringify, freshly detached and frozen per call). It never fails
 *   with authority_unavailable itself: the disabled state is data
 *   ({enabled:false}) whose strict policy decode the real resolver rejects,
 *   which is where authority_unavailable originates.
 * - `current` is a local synchronous snapshot: no effects, promises, SQL,
 *   network, filesystem, or awaits. Revisions change only on controller
 *   operations, so the resolver's equal-revision checks bracketing a
 *   synchronized registry read stay stable across reads.
 * - No history is kept: one cell, overwritten in ONE atomic assignment per
 *   operation. No timers, subscribers, or locking framework.
 */
export interface MissionMcpPolicyService {
  readonly read: Effect.Effect<unknown, MissionMcpService.MissionMcpFailure>;
  readonly current: () => unknown;
}

/**
 * Trusted server-configuration-only controller. ROOT ONLY: no MCP toolkit,
 * default layer, or public caller route may reach these methods.
 */
export class MissionMcpPolicyPublisher {
  private readonly publisherId: string;
  private counter: bigint;
  private state: PublishedMissionMcpPolicy | DisabledPolicySnapshot;
  readonly policy: MissionMcpPolicyService;

  constructor() {
    this.publisherId = NodeCrypto.randomUUID();
    this.counter = 0n;
    this.state = this.freezeDisabled(this.mintRevision());
    const current = (): unknown => freezeDetached({ ...(this.state as object) });
    this.policy = {
      read: Effect.sync(current),
      current,
    };
  }

  /**
   * Mint a publisher-owned revision independent of the caller: an instance
   * crypto-random identifier plus a monotonic counter, serialized as a
   * readonly string. The counter is a BigInt with no practical exhaustion
   * point; any mint failure throws before state is touched (fail closed).
   */
  private mintRevision(): string {
    const revision = `${this.publisherId}#${this.counter.toString()}`;
    this.counter += 1n;
    return revision;
  }

  private freezeDisabled(revision: string): DisabledPolicySnapshot {
    return freezeDetached({ enabled: false as const, revision });
  }

  /**
   * Publish a strictly decoded bounded root configuration. Every successful
   * or failed call consumes a fresh never-reused revision, including repeated
   * semantically identical updates. An invalid update denies, clears any
   * enabled state (no stale allowed last-good fallback), and throws a
   * bounded error with no configuration echo.
   */
  publish(config: unknown): PublishedMissionMcpPolicy {
    let decoded: RootTrustedPolicyConfig;
    try {
      decoded = decodeConfig(config);
    } catch {
      // Invalid input revokes: fresh revision, disabled, no stale fallback.
      this.state = this.freezeDisabled(this.mintRevision());
      throw new MissionMcpPolicyError();
    }
    if (
      decoded.allowedProjectIds.length === 0 ||
      decoded.allowedProjectIds.length > MAX_POLICY_LIST_IDS ||
      decoded.bootstrapControllerThreadIds.length > MAX_POLICY_LIST_IDS ||
      hasDuplicates(decoded.allowedProjectIds) ||
      hasDuplicates(decoded.bootstrapControllerThreadIds)
    ) {
      this.state = this.freezeDisabled(this.mintRevision());
      throw new MissionMcpPolicyError();
    }
    let published: PublishedMissionMcpPolicy;
    try {
      published = decodePublished({
        enabled: true,
        company: decoded.company,
        companyVerified: decoded.companyVerified,
        bindingVerified: decoded.bindingVerified,
        policyRef: decoded.policyRef,
        revision: this.mintRevision(),
        teamId: decoded.teamId,
        environmentId: decoded.environmentId,
        allowedProjectIds: [...decoded.allowedProjectIds],
        bootstrapControllerThreadIds: [...decoded.bootstrapControllerThreadIds],
      });
    } catch {
      this.state = this.freezeDisabled(this.mintRevision());
      throw new MissionMcpPolicyError();
    }
    // ONE atomic assignment of an immutable detached snapshot.
    this.state = freezeDetached(published);
    return freezeDetached(this.state as PublishedMissionMcpPolicy);
  }

  /** Clear enabled state with a fresh never-reused revision. ROOT ONLY. */
  disable(): void {
    this.state = this.freezeDisabled(this.mintRevision());
  }

  /**
   * Explicit revocation: same fail-closed clearing as disable, always
   * consuming its own fresh revision even when already disabled. ROOT ONLY.
   */
  revoke(): void {
    this.state = this.freezeDisabled(this.mintRevision());
  }
}
