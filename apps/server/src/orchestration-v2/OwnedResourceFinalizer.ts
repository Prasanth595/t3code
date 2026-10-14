import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * Deterministic owned-resource finalization seam.
 *
 * The input is a durable receipt captured by the future mission aggregate:
 * it binds the resource, the owning task and attempt, the controller epoch,
 * the host and boot identity, the exact resource identity, the observed
 * lifecycle, and the owner's terminal acknowledgement. Finalization never
 * infers ownership from names, paths, or lease expiry, and it keeps no
 * in-memory owning registry: every decision derives from the receipt, the
 * current controller/host identity supplied to `finalize`, and a live
 * inspection of the exact identity through the probe port.
 *
 * The method returns a structured cleanup receipt for every outcome,
 * including declines and stop failures, so the runtime caller can persist it
 * through the existing mission transaction. A stop failure is an explicit
 * `stop-failed` receipt, never a `cleaned` one.
 */
export type OwnedResourceKind =
  | "process"
  | "simulator"
  | "browser"
  | "port"
  | "container"
  | "session";

export interface ProcessResourceIdentity {
  readonly kind: "process";
  readonly pid: number;
  readonly birth: string;
  readonly group?: string | undefined;
}

export interface SimulatorResourceIdentity {
  readonly kind: "simulator";
  readonly deviceSet: string;
  readonly udid: string;
}

export interface BrowserResourceIdentity {
  readonly kind: "browser";
  readonly contextId: string;
}

export interface PortResourceIdentity {
  readonly kind: "port";
  readonly port: number;
  readonly pid: number;
  readonly birth: string;
}

export interface ContainerResourceIdentity {
  readonly kind: "container";
  readonly containerId: string;
}

export interface SessionResourceIdentity {
  readonly kind: "session";
  readonly sessionId: string;
}

export type OwnedResourceIdentity =
  | ProcessResourceIdentity
  | SimulatorResourceIdentity
  | BrowserResourceIdentity
  | PortResourceIdentity
  | ContainerResourceIdentity
  | SessionResourceIdentity;

export type OwnedResourceLifecycle = "captured" | "active" | "uncertain" | "terminal" | "cleaned";

export type OwnerTerminalStatus = "completed" | "failed" | "cancelled" | "cancel-requested";

export interface OwnerTerminalReceipt {
  readonly status: OwnerTerminalStatus;
  readonly acknowledged: boolean;
}

export interface OwnedResourceReceipt {
  readonly resourceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly controllerEpoch: number;
  readonly hostId: string;
  readonly bootId: string;
  readonly kind: OwnedResourceKind;
  readonly identity: OwnedResourceIdentity;
  readonly lifecycle: OwnedResourceLifecycle;
  readonly owner: OwnerTerminalReceipt;
  readonly expiresAt?: string | undefined;
  readonly sharedOwners: ReadonlyArray<string>;
  readonly protected: boolean;
  readonly keepAlive: boolean;
}

export interface FinalizeController {
  readonly epoch: number;
  readonly hostId: string;
  readonly bootId: string;
}

export interface FinalizeInput {
  readonly receipt: OwnedResourceReceipt;
  readonly controller: FinalizeController;
  readonly nowIso: string;
}

export type CleanupStatus =
  | "cleaned"
  | "settled-absent"
  | "already-cleaned"
  | "declined"
  | "unreconciled"
  | "stop-failed"
  | "postcheck-live"
  | "failed";

export interface OwnedResourceCleanupReceipt {
  readonly resourceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly kind: OwnedResourceKind;
  readonly status: CleanupStatus;
  readonly reason: string;
  readonly stopped: boolean;
  readonly verifiedAbsent: boolean;
}

export interface ProbeObservation {
  readonly found: boolean;
  readonly matchesIdentity: boolean;
}

export class ResourceProbeError extends Schema.TaggedError<ResourceProbeError>()(
  "ResourceProbeError",
  {
    operation: Schema.Literals(["inspect", "stop"]),
    kind: Schema.String,
    category: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OwnedResourceProbe extends Context.Service<
  OwnedResourceProbe,
  {
    /**
     * Observe the resource behind the exact identity. `found` reports
     * whether anything exists at the identity's lookup key, and
     * `matchesIdentity` reports whether the live resource still carries the
     * full exact identity (birth, UDID, container id, ...). A reused PID
     * with a different birth reports `found: true, matchesIdentity: false`.
     */
    readonly inspect: (
      identity: OwnedResourceIdentity,
    ) => Effect.Effect<ProbeObservation, ResourceProbeError>;
    /**
     * Stop the resource behind the exact identity. Called only after an
     * inspection verified the live resource matches the receipt identity.
     */
    readonly stop: (identity: OwnedResourceIdentity) => Effect.Effect<void, ResourceProbeError>;
  }
>()("t3/orchestration-v2/OwnedResourceFinalizer/OwnedResourceProbe") {}

export class OwnedResourceFinalizer extends Context.Service<
  OwnedResourceFinalizer,
  {
    readonly finalize: (input: FinalizeInput) => Effect.Effect<OwnedResourceCleanupReceipt>;
  }
>()("t3/orchestration-v2/OwnedResourceFinalizer") {}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const validPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const validPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;

/**
 * Exact-identity completeness per kind. A port alone never proves the
 * owning PID, so a port identity without the owning PID and birth is
 * incomplete. Nothing is inferred from names, paths, or lease expiry.
 */
const hasExactIdentity = (receipt: OwnedResourceReceipt): boolean => {
  const identity = receipt.identity as OwnedResourceIdentity | null | undefined;
  if (identity === null || identity === undefined) {
    return false;
  }
  if (identity.kind !== receipt.kind) {
    return false;
  }
  switch (identity.kind) {
    case "process":
      return validPid(identity.pid) && nonEmpty(identity.birth);
    case "port":
      return validPort(identity.port) && validPid(identity.pid) && nonEmpty(identity.birth);
    case "simulator":
      return nonEmpty(identity.deviceSet) && nonEmpty(identity.udid);
    case "browser":
      return nonEmpty(identity.contextId);
    case "container":
      return nonEmpty(identity.containerId);
    case "session":
      return nonEmpty(identity.sessionId);
    default:
      return false;
  }
};

const isTerminalOwnerAck = (owner: OwnerTerminalReceipt): boolean =>
  owner.acknowledged === true &&
  (owner.status === "completed" || owner.status === "failed" || owner.status === "cancelled");

const ownerDeclineReason = (owner: OwnerTerminalReceipt): string =>
  owner.status === "cancel-requested" ? "cancel-request-only" : "owner-not-terminal-ack";

/**
 * Lease expiry only ever declines an uncertain resource. It is never used
 * to infer ownership or to permit a stop.
 */
const isExpiredUncertain = (receipt: OwnedResourceReceipt, nowIso: string): boolean => {
  if (receipt.lifecycle !== "uncertain") {
    return false;
  }
  if (!nonEmpty(receipt.expiresAt)) {
    return false;
  }
  const expires = Date.parse(receipt.expiresAt as string);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now)) {
    return false;
  }
  return now >= expires;
};

const make = Effect.gen(function* () {
  const probe = yield* OwnedResourceProbe;

  const finalize = (input: FinalizeInput): Effect.Effect<OwnedResourceCleanupReceipt> =>
    Effect.gen(function* () {
      const { receipt, controller, nowIso } = input;
      const base = {
        resourceId: receipt.resourceId,
        taskId: receipt.taskId,
        attemptId: receipt.attemptId,
        kind: receipt.kind,
      };
      const decline = (reason: string): OwnedResourceCleanupReceipt => ({
        ...base,
        status: "declined",
        reason,
        stopped: false,
        verifiedAbsent: false,
      });

      // An already-cleaned receipt is idempotent: no probe contact.
      if (receipt.lifecycle === "cleaned") {
        return {
          ...base,
          status: "already-cleaned",
          reason: "already-cleaned",
          stopped: false,
          verifiedAbsent: false,
        };
      }
      if (
        !nonEmpty(receipt.resourceId) ||
        !nonEmpty(receipt.taskId) ||
        !nonEmpty(receipt.attemptId) ||
        !nonEmpty(receipt.hostId) ||
        !nonEmpty(receipt.bootId) ||
        !nonEmpty(controller.hostId) ||
        !nonEmpty(controller.bootId) ||
        !Number.isInteger(receipt.controllerEpoch) ||
        receipt.controllerEpoch < 0 ||
        !Number.isInteger(controller.epoch) ||
        controller.epoch < 0 ||
        !Array.isArray(receipt.sharedOwners) ||
        typeof receipt.protected !== "boolean" ||
        typeof receipt.keepAlive !== "boolean"
      ) {
        return decline("unknown-ownership");
      }
      if (receipt.controllerEpoch !== controller.epoch) {
        return decline("stale-controller-epoch");
      }
      if (receipt.hostId !== controller.hostId) {
        return decline("wrong-host");
      }
      if (receipt.bootId !== controller.bootId) {
        return decline("wrong-boot");
      }
      if (!hasExactIdentity(receipt)) {
        return decline("missing-exact-identity");
      }
      if (receipt.lifecycle !== "terminal") {
        return decline(
          isExpiredUncertain(receipt, nowIso) ? "expired-uncertain" : "nonterminal-lifecycle",
        );
      }
      if (!isTerminalOwnerAck(receipt.owner)) {
        return decline(ownerDeclineReason(receipt.owner));
      }
      if (receipt.sharedOwners.length > 0) {
        return decline("shared-owners");
      }
      if (receipt.protected === true) {
        return decline("protected-resource");
      }
      if (receipt.keepAlive === true) {
        return decline("keep-alive");
      }

      const observed = yield* Effect.result(probe.inspect(receipt.identity));
      if (observed._tag === "Failure") {
        return {
          ...base,
          status: "failed",
          reason: `inspect-failed:${observed.failure.category}`,
          stopped: false,
          verifiedAbsent: false,
        };
      }
      // Missing resource settles absent without a stop.
      if (!observed.success.found) {
        return {
          ...base,
          status: "settled-absent",
          reason: "resource-absent",
          stopped: false,
          verifiedAbsent: true,
        };
      }
      // Changed or reused identity (a recycled PID, a replaced container)
      // is fenced off as unreconciled: never stop a stranger's resource.
      if (!observed.success.matchesIdentity) {
        return {
          ...base,
          status: "unreconciled",
          reason: "identity-changed",
          stopped: false,
          verifiedAbsent: false,
        };
      }

      const stopped = yield* Effect.result(probe.stop(receipt.identity));
      if (stopped._tag === "Failure") {
        return {
          ...base,
          status: "stop-failed",
          reason: `stop-failed:${stopped.failure.category}`,
          stopped: false,
          verifiedAbsent: false,
        };
      }

      // Re-observe absence before reporting cleaned.
      const postcheck = yield* Effect.result(probe.inspect(receipt.identity));
      if (postcheck._tag === "Failure") {
        return {
          ...base,
          status: "failed",
          reason: `postcheck-failed:${postcheck.failure.category}`,
          stopped: true,
          verifiedAbsent: false,
        };
      }
      if (postcheck.success.found) {
        return {
          ...base,
          status: "postcheck-live",
          reason: "resource-still-present",
          stopped: true,
          verifiedAbsent: false,
        };
      }
      return {
        ...base,
        status: "cleaned",
        reason: "stopped-and-verified",
        stopped: true,
        verifiedAbsent: true,
      };
    });

  return OwnedResourceFinalizer.of({ finalize });
});

export const layer: Layer.Layer<OwnedResourceFinalizer, never, OwnedResourceProbe> = Layer.effect(
  OwnedResourceFinalizer,
  make,
);
