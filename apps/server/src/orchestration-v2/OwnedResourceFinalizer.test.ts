import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as OwnedResourceFinalizer from "./OwnedResourceFinalizer.ts";

type Identity = OwnedResourceFinalizer.OwnedResourceIdentity;
type Receipt = OwnedResourceFinalizer.OwnedResourceReceipt;

interface FakeEntry {
  readonly identity: Identity;
  readonly stopFailsWith?: string | undefined;
  readonly stopRemoves?: boolean | undefined;
  present: boolean;
}

interface ProbeCall {
  readonly operation: "inspect" | "stop";
  readonly identity: Identity;
}

const identityKey = (identity: Identity): string => {
  switch (identity.kind) {
    case "process":
      return `process:${identity.pid}`;
    case "port":
      return `port:${identity.port}`;
    case "simulator":
      return `simulator:${identity.udid}`;
    case "browser":
      return `browser:${identity.contextId}`;
    case "container":
      return `container:${identity.containerId}`;
    case "session":
      return `session:${identity.sessionId}`;
    default:
      return "unknown";
  }
};

const sameIdentity = (a: Identity, b: Identity): boolean => {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "process":
      return (
        b.kind === "process" &&
        b.pid === a.pid &&
        b.birth === a.birth &&
        (b.group ?? null) === (a.group ?? null)
      );
    case "port":
      return b.kind === "port" && b.port === a.port && b.pid === a.pid && b.birth === a.birth;
    case "simulator":
      return b.kind === "simulator" && b.deviceSet === a.deviceSet && b.udid === a.udid;
    case "browser":
      return b.kind === "browser" && b.contextId === a.contextId;
    case "container":
      return b.kind === "container" && b.containerId === a.containerId;
    case "session":
      return b.kind === "session" && b.sessionId === a.sessionId;
    default:
      return false;
  }
};

const baseController: OwnedResourceFinalizer.FinalizeController = {
  epoch: 7,
  hostId: "host-1",
  bootId: "boot-1",
};

const nowIso = "2026-10-14T03:00:00.000Z";

const processIdentity = (
  overrides?: Partial<OwnedResourceFinalizer.ProcessResourceIdentity>,
): OwnedResourceFinalizer.ProcessResourceIdentity => ({
  kind: "process",
  pid: 4242,
  birth: "birth-1",
  group: "group-1",
  ...overrides,
});

const baseReceipt = (overrides?: Partial<Receipt>): Receipt => ({
  resourceId: "resource-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  controllerEpoch: 7,
  hostId: "host-1",
  bootId: "boot-1",
  kind: "process",
  identity: processIdentity(),
  lifecycle: "terminal",
  owner: { status: "completed", acknowledged: true },
  sharedOwners: [],
  protected: false,
  keepAlive: false,
  ...overrides,
});

const runFinalize = (args: {
  readonly receipt: Receipt;
  readonly controller?: OwnedResourceFinalizer.FinalizeController;
  readonly nowIso?: string;
  readonly entries?: ReadonlyArray<FakeEntry>;
}) => {
  const calls: Array<ProbeCall> = [];
  const live = new Map<string, FakeEntry>();
  for (const entry of args.entries ?? []) {
    live.set(identityKey(entry.identity), { ...entry, present: entry.present });
  }
  const probe = OwnedResourceFinalizer.OwnedResourceProbe.of({
    inspect: (identity) =>
      Effect.sync(() => {
        calls.push({ operation: "inspect", identity });
        const entry = live.get(identityKey(identity));
        if (entry === undefined || !entry.present) {
          return { found: false, matchesIdentity: false };
        }
        return { found: true, matchesIdentity: sameIdentity(entry.identity, identity) };
      }),
    stop: (identity) =>
      Effect.gen(function* () {
        calls.push({ operation: "stop", identity });
        const entry = live.get(identityKey(identity));
        if (entry?.stopFailsWith !== undefined) {
          return yield* new OwnedResourceFinalizer.ResourceProbeError({
            operation: "stop",
            kind: identity.kind,
            category: entry.stopFailsWith,
          });
        }
        if (entry !== undefined && entry.stopRemoves !== false) {
          entry.present = false;
        }
      }),
  });
  const layerTest = OwnedResourceFinalizer.layer.pipe(
    Layer.provide(Layer.succeed(OwnedResourceFinalizer.OwnedResourceProbe, probe)),
  );
  return Effect.gen(function* () {
    const finalizer = yield* OwnedResourceFinalizer.OwnedResourceFinalizer;
    const outcome = yield* finalizer.finalize({
      receipt: args.receipt,
      controller: args.controller ?? baseController,
      nowIso: args.nowIso ?? nowIso,
    });
    return { outcome, calls, live };
  }).pipe(Effect.provide(layerTest));
};

describe("OwnedResourceFinalizer", () => {
  it.effect("cleans a completed-ack terminal process after verifying the exact identity", () =>
    Effect.gen(function* () {
      const identity = processIdentity();
      const { outcome, calls } = yield* runFinalize({
        receipt: baseReceipt({ identity }),
        entries: [{ identity, present: true }],
      });
      expect(outcome.status).toBe("cleaned");
      expect(outcome.reason).toBe("stopped-and-verified");
      expect(outcome.stopped).toBe(true);
      expect(outcome.verifiedAbsent).toBe(true);
      expect(calls.map((call) => call.operation)).toEqual(["inspect", "stop", "inspect"]);
      for (const call of calls) {
        expect(call.identity).toEqual(identity);
      }
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("treats failure and cancel acks like completion acks", () =>
    Effect.gen(function* () {
      for (const status of ["failed", "cancelled"] as const) {
        const identity = processIdentity({ pid: status === "failed" ? 4243 : 4244 });
        const { outcome } = yield* runFinalize({
          receipt: baseReceipt({ identity, owner: { status, acknowledged: true } }),
          entries: [{ identity, present: true }],
        });
        expect(outcome.status).toBe("cleaned");
        expect(outcome.stopped).toBe(true);
        expect(outcome.verifiedAbsent).toBe(true);
      }
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("declines a cancel request without an ack and never touches the probe", () =>
    Effect.gen(function* () {
      const requested = yield* runFinalize({
        receipt: baseReceipt({ owner: { status: "cancel-requested", acknowledged: false } }),
        entries: [{ identity: processIdentity(), present: true }],
      });
      expect(requested.outcome.status).toBe("declined");
      expect(requested.outcome.reason).toBe("cancel-request-only");
      expect(requested.outcome.stopped).toBe(false);
      expect(requested.calls).toEqual([]);

      const unacked = yield* runFinalize({
        receipt: baseReceipt({ owner: { status: "completed", acknowledged: false } }),
      });
      expect(unacked.outcome.status).toBe("declined");
      expect(unacked.outcome.reason).toBe("owner-not-terminal-ack");
      expect(unacked.calls).toEqual([]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("leaves a reused PID alone when the birth no longer matches", () =>
    Effect.gen(function* () {
      const receiptIdentity = processIdentity({ pid: 4242, birth: "birth-1" });
      const liveIdentity = processIdentity({ pid: 4242, birth: "birth-2" });
      const { outcome, calls } = yield* runFinalize({
        receipt: baseReceipt({ identity: receiptIdentity }),
        entries: [{ identity: liveIdentity, present: true }],
      });
      expect(outcome.status).toBe("unreconciled");
      expect(outcome.reason).toBe("identity-changed");
      expect(outcome.stopped).toBe(false);
      expect(outcome.verifiedAbsent).toBe(false);
      expect(calls.map((call) => call.operation)).toEqual(["inspect"]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("declines when the host or boot changed under the receipt", () =>
    Effect.gen(function* () {
      const wrongBoot = yield* runFinalize({
        receipt: baseReceipt(),
        controller: { ...baseController, bootId: "boot-2" },
        entries: [{ identity: processIdentity(), present: true }],
      });
      expect(wrongBoot.outcome.status).toBe("declined");
      expect(wrongBoot.outcome.reason).toBe("wrong-boot");
      expect(wrongBoot.calls).toEqual([]);

      const wrongHost = yield* runFinalize({
        receipt: baseReceipt(),
        controller: { ...baseController, hostId: "host-2" },
      });
      expect(wrongHost.outcome.status).toBe("declined");
      expect(wrongHost.outcome.reason).toBe("wrong-host");
      expect(wrongHost.calls).toEqual([]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("declines shared, protected, and keep-alive resources without touching neighbors", () =>
    Effect.gen(function* () {
      const target = processIdentity({ pid: 4242 });
      const neighbor = processIdentity({ pid: 4343, birth: "birth-neighbor" });
      const entries: ReadonlyArray<FakeEntry> = [
        { identity: target, present: true },
        { identity: neighbor, present: true },
      ];
      const shared = yield* runFinalize({
        receipt: baseReceipt({ identity: target, sharedOwners: ["task-2"] }),
        entries,
      });
      expect(shared.outcome.status).toBe("declined");
      expect(shared.outcome.reason).toBe("shared-owners");
      const guarded = yield* runFinalize({
        receipt: baseReceipt({ identity: target, protected: true }),
        entries,
      });
      expect(guarded.outcome.status).toBe("declined");
      expect(guarded.outcome.reason).toBe("protected-resource");
      const kept = yield* runFinalize({
        receipt: baseReceipt({ identity: target, keepAlive: true }),
        entries,
      });
      expect(kept.outcome.status).toBe("declined");
      expect(kept.outcome.reason).toBe("keep-alive");
      for (const result of [shared, guarded, kept]) {
        expect(result.calls).toEqual([]);
        expect(result.live.get(identityKey(target))?.present).toBe(true);
        expect(result.live.get(identityKey(neighbor))?.present).toBe(true);
      }
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("treats an already-cleaned receipt as done without probing, twice", () =>
    Effect.gen(function* () {
      for (let round = 0; round < 2; round += 1) {
        const { outcome, calls } = yield* runFinalize({
          receipt: baseReceipt({ lifecycle: "cleaned" }),
          entries: [{ identity: processIdentity(), present: true }],
        });
        expect(outcome.status).toBe("already-cleaned");
        expect(outcome.stopped).toBe(false);
        expect(calls).toEqual([]);
      }
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("settles an absent resource without stopping", () =>
    Effect.gen(function* () {
      const identity = processIdentity();
      const { outcome, calls } = yield* runFinalize({
        receipt: baseReceipt({ identity }),
        entries: [],
      });
      expect(outcome.status).toBe("settled-absent");
      expect(outcome.reason).toBe("resource-absent");
      expect(outcome.stopped).toBe(false);
      expect(outcome.verifiedAbsent).toBe(true);
      expect(calls.map((call) => call.operation)).toEqual(["inspect"]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("reports a stop failure explicitly and never marks cleaned", () =>
    Effect.gen(function* () {
      const identity = processIdentity();
      const { outcome, calls, live } = yield* runFinalize({
        receipt: baseReceipt({ identity }),
        entries: [{ identity, present: true, stopFailsWith: "permission-denied" }],
      });
      expect(outcome.status).toBe("stop-failed");
      expect(outcome.reason).toBe("stop-failed:permission-denied");
      expect(outcome.stopped).toBe(false);
      expect(outcome.verifiedAbsent).toBe(false);
      expect(calls.map((call) => call.operation)).toEqual(["inspect", "stop"]);
      expect(live.get(identityKey(identity))?.present).toBe(true);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("reports postcheck-live when the resource survives stop", () =>
    Effect.gen(function* () {
      const identity = processIdentity();
      const { outcome, calls } = yield* runFinalize({
        receipt: baseReceipt({ identity }),
        entries: [{ identity, present: true, stopRemoves: false }],
      });
      expect(outcome.status).toBe("postcheck-live");
      expect(outcome.stopped).toBe(true);
      expect(outcome.verifiedAbsent).toBe(false);
      expect(calls.map((call) => call.operation)).toEqual(["inspect", "stop", "inspect"]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("declines a stale controller epoch", () =>
    Effect.gen(function* () {
      const { outcome, calls } = yield* runFinalize({
        receipt: baseReceipt({ controllerEpoch: 6 }),
        entries: [{ identity: processIdentity(), present: true }],
      });
      expect(outcome.status).toBe("declined");
      expect(outcome.reason).toBe("stale-controller-epoch");
      expect(outcome.stopped).toBe(false);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("declines nonterminal lifecycles and expired uncertain receipts", () =>
    Effect.gen(function* () {
      const active = yield* runFinalize({ receipt: baseReceipt({ lifecycle: "active" }) });
      expect(active.outcome.status).toBe("declined");
      expect(active.outcome.reason).toBe("nonterminal-lifecycle");
      expect(active.calls).toEqual([]);

      const uncertainFresh = yield* runFinalize({
        receipt: baseReceipt({ lifecycle: "uncertain", expiresAt: "2026-10-14T04:00:00.000Z" }),
      });
      expect(uncertainFresh.outcome.status).toBe("declined");
      expect(uncertainFresh.outcome.reason).toBe("nonterminal-lifecycle");
      expect(uncertainFresh.calls).toEqual([]);

      const uncertainExpired = yield* runFinalize({
        receipt: baseReceipt({ lifecycle: "uncertain", expiresAt: "2026-10-14T02:00:00.000Z" }),
      });
      expect(uncertainExpired.outcome.status).toBe("declined");
      expect(uncertainExpired.outcome.reason).toBe("expired-uncertain");
      expect(uncertainExpired.calls).toEqual([]);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it.effect("declines a port receipt that names no owning PID", () =>
    Effect.gen(function* () {
      const identity = { kind: "port", port: 8080 } as unknown as Identity;
      const { outcome, calls } = yield* runFinalize({
        receipt: baseReceipt({ kind: "port", identity }),
      });
      expect(outcome.status).toBe("declined");
      expect(outcome.reason).toBe("missing-exact-identity");
      expect(outcome.stopped).toBe(false);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(Layer.empty)),
  );
});
