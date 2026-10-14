import { assert, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Mission } from "../../../../packages/contracts/src/mission.ts";
import type { PreparedRotationIntent } from "./MissionManagerRotation.ts";
import {
  buildManagerHandoffSnapshot,
  HANDOFF_MAX_SERIALIZED_BYTES,
  serializeHandoffSnapshot,
  type BuildManagerHandoffInput,
  type BuildManagerHandoffResult,
} from "./MissionManagerHandoff.ts";

const OCCURRED_AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (overrides: Record<string, unknown> = {}) =>
  decodeMission({
    schemaVersion: 1,
    id: "mission-1",
    revision: 4,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
        ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
      },
    ],
    intent: {
      outcome: "Ship the opt-in mission aggregate.",
      scope: ["contracts"],
      exclusions: ["persistence"],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
      decisions: [{ id: "dec-1", text: "Council secret wording.", authority: { ...AUTHORITY } }],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: {
      delivery: { threadId: "thread-delivery", epoch: 3 },
      retro: { threadId: "thread-retro", epoch: 1 },
    },
    status: "active",
    tasks: [
      {
        id: "task-a",
        projectId: "project-1",
        title: "First task",
        specHash: "hash-a",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: OCCURRED_AT,
      },
      {
        id: "task-b",
        projectId: "project-1",
        title: "Second task",
        specHash: "hash-b",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: OCCURRED_AT,
      },
    ],
    updatedAt: OCCURRED_AT,
    ...overrides,
  });

const intentFixture = (overrides: Partial<PreparedRotationIntent> = {}): PreparedRotationIntent => ({
  missionId: "mission-1",
  observedRevision: 4,
  role: "delivery",
  currentThreadId: "thread-delivery",
  currentEpoch: 3,
  timezone: "America/Denver",
  localDate: "2026-10-14",
  ordinal: 0,
  reason: "first_slot",
  ...overrides,
});

const inputFixture = (overrides: Partial<BuildManagerHandoffInput> = {}): BuildManagerHandoffInput => ({
  mission: missionFixture(),
  intent: intentFixture(),
  ...overrides,
});

const mustOk = (result: BuildManagerHandoffResult) => {
  assert(result.ok === true, `expected ok, got ${JSON.stringify(result)}`);
  return result;
};

const mustReject = (result: BuildManagerHandoffResult, reason: string) => {
  assert(result.ok === false, "expected a bounded rejection");
  expect(result.reason).toBe(reason);
  expect(result.detail.length).toBeGreaterThan(0);
  return result;
};

describe("buildManagerHandoffSnapshot", () => {
  it("builds a minimal snapshot bound to the canonical mission and intent", () => {
    const result = mustOk(buildManagerHandoffSnapshot(inputFixture()));
    expect(result.snapshot.schemaVersion).toBe(1);
    expect(result.snapshot.serialization).toEqual({
      encoding: "utf8-json",
      canonicalization: "stable-stringify-v1",
    });
    expect(result.snapshot.mission).toEqual({
      ref: "mission-1",
      revision: 4,
      teamId: "team-1",
      environmentId: "env-1",
    });
    expect(result.snapshot.manager).toEqual({
      role: "delivery",
      threadId: "thread-delivery",
      epoch: 3,
    });
    expect(result.snapshot.boundary).toEqual({
      timezone: "America/Denver",
      localDate: "2026-10-14",
      ordinal: 0,
      reason: "first_slot",
    });
    expect(result.snapshot.decisions).toHaveLength(1);
    expect(result.snapshot.decisions[0]?.id).toBe("dec-1");
    expect(result.snapshot.decisions[0]?.canonicalRef).toBe("mission-1@4:decision:0");
    expect(result.snapshot.decisions[0]?.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.snapshot.scope.count).toBe(1);
    expect(result.snapshot.scope.digest).toMatch(/^[0-9a-f]{64}$/);
    const ser0 = new TextDecoder().decode(result.bytes);
    expect(ser0).not.toContain("mission-council");
    expect(ser0).not.toContain("decision-2026-001");
    expect(ser0).not.toContain("contracts");
    expect(result.snapshot.acceptance).toEqual([{ id: "ac-1" }]);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a stale intent revision", () => {
    const result = buildManagerHandoffSnapshot(inputFixture({ intent: intentFixture({ observedRevision: 3 }) }));
    mustReject(result, "stale_intent");
  });

  it("rejects a mismatched manager binding and mission identity", () => {
    const threadMismatch = buildManagerHandoffSnapshot(
      inputFixture({ intent: intentFixture({ currentThreadId: "thread-other" }) }),
    );
    mustReject(threadMismatch, "intent_mismatch");
    const epochMismatch = buildManagerHandoffSnapshot(
      inputFixture({ intent: intentFixture({ currentEpoch: 9 }) }),
    );
    mustReject(epochMismatch, "intent_mismatch");
    const missionMismatch = buildManagerHandoffSnapshot(
      inputFixture({ intent: intentFixture({ missionId: "mission-other" }) }),
    );
    mustReject(missionMismatch, "intent_mismatch");
  });

  it("rejects inactive missions", () => {
    const result = buildManagerHandoffSnapshot(inputFixture({ mission: missionFixture({ status: "paused" }) }));
    mustReject(result, "mission_inactive");
  });

  it("denies credential-smuggling pointers and serializes no secret text", () => {
    const smuggled = buildManagerHandoffSnapshot(
      inputFixture({ blockers: [{ id: "block-1", ref: "fix-1?token=abc" }] }),
    );
    mustReject(smuggled, "forbidden_pointer");
    const paired = buildManagerHandoffSnapshot(
      inputFixture({ blockers: [{ id: "block-1", ref: "api_key=hunter2" }] }),
    );
    mustReject(paired, "forbidden_pointer");

    const clean = mustOk(buildManagerHandoffSnapshot(inputFixture()));
    const serialized = new TextDecoder().decode(clean.bytes);
    expect(serialized).not.toContain("Council secret wording.");
    expect(serialized).not.toContain("Ship the opt-in mission aggregate.");
    expect(serialized).toContain("mission-1");
  });

  it("keeps unknown distinct from known-empty", () => {
    const bare = mustOk(buildManagerHandoffSnapshot(inputFixture()));
    expect(bare.snapshot.ownership).toEqual({ state: "unknown", reason: "not-supplied" });
    expect(bare.snapshot.pendingResults.state).toBe("unknown");
    expect(bare.snapshot.predecessor.state).toBe("unknown");

    const explicit = mustOk(
      buildManagerHandoffSnapshot(inputFixture({ ownership: [], pendingResults: [] })),
    );
    expect(explicit.snapshot.ownership).toEqual({ state: "known", items: [] });
    expect(explicit.snapshot.pendingResults).toEqual({ state: "known", items: [] });
  });

  it("bounds every list at sixteen entries", () => {
    const oversized = Array.from({ length: 17 }, (_, index) => ({ id: `block-${index}` }));
    const result = buildManagerHandoffSnapshot(inputFixture({ blockers: oversized }));
    mustReject(result, "array_overflow");

    const ownershipOversized = Array.from({ length: 17 }, () => ({ taskId: "task-a" }));
    const ownershipResult = buildManagerHandoffSnapshot(inputFixture({ ownership: ownershipOversized }));
    mustReject(ownershipResult, "array_overflow");
  });

  it("bounds overlong strings", () => {
    const longScope = missionFixture({
      intent: {
        outcome: "Ship the opt-in mission aggregate.",
        scope: ["\u00e9".repeat(2500)],
        exclusions: [],
        authorityRefs: [{ ...AUTHORITY }],
        acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
        decisions: [],
      },
    });
    const scopeResult = buildManagerHandoffSnapshot(inputFixture({ mission: longScope }));
    mustReject(scopeResult, "string_overflow");

    const longRef = buildManagerHandoffSnapshot(
      inputFixture({ blockers: [{ id: "block-1", ref: `r-${"y".repeat(300)}` }] }),
    );
    mustReject(longRef, "invalid_pointer");
  });

  it("keeps a dense snapshot inside the 64KiB UTF-8 budget", () => {
    const wide = (prefix: string) => `ref:${prefix}-${"z".repeat(180)}`;
    const decisions = Array.from({ length: 16 }, (_, index) => ({
      id: `dec-${index}`,
      text: `Decision ${index}`,
      authority: { source: "council", ref: `ref-${index}` },
    }));
    const mission = missionFixture({
      intent: {
        outcome: "Ship the opt-in mission aggregate.",
        scope: Array.from({ length: 16 }, (_, index) => `scope-${index}-${"s".repeat(160)}`),
        exclusions: [],
        authorityRefs: [{ ...AUTHORITY }],
        acceptanceCriteria: Array.from({ length: 16 }, (_, index) => ({
          id: `ac-${index}`,
          text: "Criterion.",
        })),
        decisions,
      },
    });
    const result = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          mission,
          ownership: Array.from({ length: 16 }, (_, index) => ({
            taskId: "task-a",
            threadId: `worker-${index}`,
            runId: `run-${index}-${"q".repeat(80)}`,
            attemptNumber: index,
          })),
          pendingResults: Array.from({ length: 16 }, (_, index) => ({
            taskId: "task-b",
            dispatchKey: `dispatch-${index}`,
            resultRevision: index,
          })),
          blockers: Array.from({ length: 16 }, (_, index) => ({ id: `b-${index}`, ref: wide(`b-${index}`) })),
          nextActions: Array.from({ length: 16 }, (_, index) => ({ id: `n-${index}` })),
          resourceHolds: Array.from({ length: 16 }, (_, index) => ({
            holdId: `hold-${index}`,
            keepAliveRef: wide(`ka-${index}`),
          })),
          integration: { branch: "feature/handoff", buildRef: wide("build"), commit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d" },
          coverage: { coverage: "partial", candidate: "proposed", runtime: "active", reportRef: "ref:report-7" },
          routePolicy: { ref: "ref:policy-main", revision: "123e4567-e89b-42d3-a456-426614174000#2" },
          deadline: { cursor: 42, ref: "ref:delivery-cursor" },
          predecessor: {
            missionId: "mission-1",
            teamId: "team-1",
            environmentId: "env-1",
            role: "delivery",
            managerThreadId: "thread-yesterday",
            epoch: 2,
            localDate: "2026-10-13",
            ordinal: 0,
          },
        }),
      ),
    );
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBeLessThanOrEqual(HANDOFF_MAX_SERIALIZED_BYTES);
  });

  it("survives caller mutation and stays deeply frozen", () => {
    const ownership = [{ taskId: "task-a", threadId: "worker-1" }];
    const mission = missionFixture();
    const before = mustOk(buildManagerHandoffSnapshot(inputFixture({ mission, ownership })));
    ownership.push({ taskId: "task-b", threadId: "worker-2" });
    const after = serializeHandoffSnapshot(before.snapshot);
    expect(after.sha256Hex).toBe(before.sha256Hex);
    expect(after.bytes).toEqual(before.bytes);
    expect(after.bytes).not.toBe(before.bytes);

    expect(Object.isFrozen(before.snapshot)).toBe(true);
    expect(Object.isFrozen(before.snapshot.decisions)).toBe(true);
    expect(Object.isFrozen(before.snapshot.mission)).toBe(true);
    expect(Object.isFrozen(before.snapshot.ownership)).toBe(true);
    expect(() => {
      (before.snapshot.mission as { ref: string }).ref = "evil";
    }).toThrow();
  });

  it("digests deterministically across distinct but equal inputs", () => {
    const first = mustOk(buildManagerHandoffSnapshot(inputFixture({ ownership: [{ taskId: "task-a" }] })));
    const second = mustOk(buildManagerHandoffSnapshot(inputFixture({ ownership: [{ taskId: "task-a" }] })));
    expect(second.sha256Hex).toBe(first.sha256Hex);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it("changes digest when epoch, revision, ownership, or results change", () => {
    const baseline = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({ ownership: [{ taskId: "task-a" }], pendingResults: [{ taskId: "task-b" }] }),
      ),
    ).sha256Hex;

    const epochMission = missionFixture({
      revision: 5,
      managers: { delivery: { threadId: "thread-delivery", epoch: 4 } },
    });
    const epochChanged = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          mission: epochMission,
          intent: intentFixture({ observedRevision: 5, currentEpoch: 4 }),
          ownership: [{ taskId: "task-a" }],
          pendingResults: [{ taskId: "task-b" }],
        }),
      ),
    ).sha256Hex;
    expect(epochChanged).not.toBe(baseline);

    const revisionMission = missionFixture({ revision: 5 });
    const revisionChanged = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          mission: revisionMission,
          intent: intentFixture({ observedRevision: 5 }),
          ownership: [{ taskId: "task-a" }],
          pendingResults: [{ taskId: "task-b" }],
        }),
      ),
    ).sha256Hex;
    expect(revisionChanged).not.toBe(baseline);

    const ownershipChanged = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          ownership: [{ taskId: "task-a" }, { taskId: "task-b" }],
          pendingResults: [{ taskId: "task-b" }],
        }),
      ),
    ).sha256Hex;
    expect(ownershipChanged).not.toBe(baseline);

    const resultChanged = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          ownership: [{ taskId: "task-a" }],
          pendingResults: [{ taskId: "task-b", dispatchKey: "dispatch-9" }],
        }),
      ),
    ).sha256Hex;
    expect(resultChanged).not.toBe(baseline);
  });

  it("handles predecessor lineage explicitly", () => {
    const missing = mustOk(buildManagerHandoffSnapshot(inputFixture()));
    expect(missing.snapshot.predecessor).toEqual({ state: "unknown", reason: "not-supplied" });

    const crossScope = buildManagerHandoffSnapshot(
      inputFixture({
        predecessor: {
          missionId: "mission-1",
          teamId: "team-other",
          environmentId: "env-1",
          role: "delivery",
          managerThreadId: "thread-yesterday",
          epoch: 2,
        },
      }),
    );
    mustReject(crossScope, "predecessor_scope_mismatch");

    const sameManager = buildManagerHandoffSnapshot(
      inputFixture({
        predecessor: {
          missionId: "mission-1",
          teamId: "team-1",
          environmentId: "env-1",
          role: "delivery",
          managerThreadId: "thread-delivery",
          epoch: 2,
        },
      }),
    );
    mustReject(sameManager, "invalid_predecessor");

    const known = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          predecessor: {
            missionId: "mission-1",
            teamId: "team-1",
            environmentId: "env-1",
            role: "delivery",
            managerThreadId: "thread-yesterday",
            epoch: 2,
          },
        }),
      ),
    );
    expect(known.snapshot.predecessor).toEqual({
      state: "known",
      value: {
        missionId: "mission-1",
        teamId: "team-1",
        environmentId: "env-1",
        role: "delivery",
        managerThreadId: "thread-yesterday",
        epoch: 2,
      },
    });
  });

  it("preserves explicit unknown coverage, candidate, and runtime state", () => {
    const result = mustOk(
      buildManagerHandoffSnapshot(
        inputFixture({
          coverage: { coverage: "unknown", candidate: "unknown", runtime: "unknown" },
        }),
      ),
    );
    expect(result.snapshot.coverage).toEqual({
      state: "known",
      value: { coverage: "unknown", candidate: "unknown", runtime: "unknown" },
    });
  });

  it("denies references to non-canonical tasks", () => {
    const ownership = buildManagerHandoffSnapshot(inputFixture({ ownership: [{ taskId: "task-ghost" }] }));
    mustReject(ownership, "unknown_task_ref");
    const results = buildManagerHandoffSnapshot(
      inputFixture({ pendingResults: [{ taskId: "task-ghost" }] }),
    );
    mustReject(results, "unknown_task_ref");
  });

  it("denies unsafe integers and out-of-bounds ordinals", () => {
    const unsafeRevision = buildManagerHandoffSnapshot(
      inputFixture({
        mission: { ...missionFixture(), revision: Number.MAX_SAFE_INTEGER + 1 },
      }),
    );
    mustReject(unsafeRevision, "invalid_mission");
    const unsafeEpoch = buildManagerHandoffSnapshot(
      inputFixture({
        mission: {
          ...missionFixture(),
          managers: { delivery: { threadId: missionFixture().managers.delivery!.threadId, epoch: Number.MAX_SAFE_INTEGER + 1 } },
        },
      }),
    );
    mustReject(unsafeEpoch, "invalid_mission");
    const ordinalOverflow = buildManagerHandoffSnapshot(
      inputFixture({ intent: intentFixture({ ordinal: 9 }) }),
    );
    mustReject(ordinalOverflow, "invalid_boundary");
  });
});


describe("root handoff metadata boundary regressions", () => {
  it("keeps canonical scope wording out of serialized reference metadata", () => {
    const mission = missionFixture();
    const scopedMission = { ...mission, intent: { ...mission.intent, scope: ["owner credential fixture-sensitive-wording"] } };
    const result = mustOk(buildManagerHandoffSnapshot(inputFixture({ mission: scopedMission })));
    expect(new TextDecoder().decode(result.bytes)).not.toContain("fixture-sensitive-wording");
  });
  it("denies raw filesystem paths in reference slots", () => {
    mustReject(buildManagerHandoffSnapshot(inputFixture({ blockers: [{ id: "block-a", ref: "/Users/nofun/private/test-only-reference" }] })), "forbidden_pointer");
  });
  it("rejects a non-hash commit identity", () => {
    mustReject(buildManagerHandoffSnapshot(inputFixture({ integration: { commit: "not-a-commit-hash" } })), "invalid_pointer");
  });
});

describe("repaired handoff boundaries", () => {
  const asInput = (value: unknown): BuildManagerHandoffInput => value as BuildManagerHandoffInput;
  it("denies encoded/url/path smuggling and plain non-namespaced refs", () => {
    for (const ref of ["ref:a%2Fb", "https://x.test/a", "file:///tmp/a", "../secret", "plain-ref", "ref:a b", "ref:a=1"]) {
      const r = buildManagerHandoffSnapshot(inputFixture({ blockers: [{ id: "b-1", ref }] }));
      assert(r.ok === false, `expected reject for ${ref}`);
    }
    mustReject(buildManagerHandoffSnapshot(inputFixture({ blockers: [{ id: "b-1", ref: "ref:a%2Fb" }] })), "forbidden_pointer");
  });
  it("accepts full 40/64-hex commits and denies abbreviated hashes", () => {
    mustOk(buildManagerHandoffSnapshot(inputFixture({ integration: { commit: "a".repeat(40) } })));
    mustOk(buildManagerHandoffSnapshot(inputFixture({ integration: { commit: "b".repeat(64) } })));
    mustReject(buildManagerHandoffSnapshot(inputFixture({ integration: { commit: "abc123" } })), "invalid_pointer");
    mustReject(buildManagerHandoffSnapshot(inputFixture({ integration: { branch: "/abs/path" } })), "forbidden_pointer");
    const okBranch = mustOk(buildManagerHandoffSnapshot(inputFixture({ integration: { branch: "feature/handoff" } })));
    expect(okBranch.snapshot.integration).toEqual({ state: "known", value: { branch: "feature/handoff" } });
  });
  it("requires actual MissionResultDisposition values", () => {
    mustOk(buildManagerHandoffSnapshot(inputFixture({ pendingResults: [{ taskId: "task-a", disposition: "advanced" }] })));
    const bad = buildManagerHandoffSnapshot(asInput({ ...inputFixture(), pendingResults: [{ taskId: "task-a", disposition: "whatever" }] }));
    mustReject(bad, "invalid_pointer");
  });
  it("round-trips publisher revision as string and denies numeric/malformed revisions", () => {
    const rev = "123e4567-e89b-42d3-a456-426614174000#42";
    const ok = mustOk(buildManagerHandoffSnapshot(inputFixture({ routePolicy: { ref: "ref:policy-main", revision: rev } })));
    expect(ok.snapshot.routePolicy).toEqual({ state: "known", value: { ref: "ref:policy-main", revision: rev } });
    expect(typeof (ok.snapshot.routePolicy as { value: { revision?: unknown } }).value.revision).toBe("string");
    mustReject(buildManagerHandoffSnapshot(asInput({ ...inputFixture(), routePolicy: { ref: "ref:policy-main", revision: 2 } })), "invalid_facts");
    mustReject(buildManagerHandoffSnapshot(asInput({ ...inputFixture(), routePolicy: { ref: "ref:policy-main", revision: "not-a-revision" } })), "invalid_facts");
    mustReject(buildManagerHandoffSnapshot(asInput({ ...inputFixture(), routePolicy: null })), "invalid_facts");
    mustReject(buildManagerHandoffSnapshot(asInput({ ...inputFixture(), coverage: null })), "invalid_facts");
    mustReject(buildManagerHandoffSnapshot(asInput({ ...inputFixture(), integration: null })), "invalid_facts");
  });
  it("changes digest when canonical scope/authority changes without serializing wording", () => {
    const base = mustOk(buildManagerHandoffSnapshot(inputFixture()));
    const m2 = missionFixture({ intent: { ...missionFixture().intent, scope: ["other-scope-wording"] } });
    const changed = mustOk(buildManagerHandoffSnapshot(inputFixture({ mission: m2 })));
    expect(changed.sha256Hex).not.toBe(base.sha256Hex);
    expect(new TextDecoder().decode(changed.bytes)).not.toContain("other-scope-wording");
    const m3 = missionFixture({ intent: { ...missionFixture().intent, decisions: [{ id: "dec-1", text: "x", authority: { source: "other-source", ref: "other-ref" } }] } });
    const changedAuth = mustOk(buildManagerHandoffSnapshot(inputFixture({ mission: m3 })));
    expect(changedAuth.sha256Hex).not.toBe(base.sha256Hex);
    expect(new TextDecoder().decode(changedAuth.bytes)).not.toContain("other-source");
  });
  it("denies predecessor future/equal epoch and non-string localDate", () => {
    const pred = { missionId: "mission-1", teamId: "team-1", environmentId: "env-1", role: "delivery" as const, managerThreadId: "thread-yesterday", epoch: 3 };
    mustReject(buildManagerHandoffSnapshot(inputFixture({ predecessor: pred })), "invalid_predecessor");
    mustReject(buildManagerHandoffSnapshot(inputFixture({ predecessor: { ...pred, epoch: 9 } })), "invalid_predecessor");
    const badDate = buildManagerHandoffSnapshot(asInput({ ...inputFixture(), predecessor: { ...pred, epoch: 2, localDate: 20261013 } }));
    mustReject(badDate, "invalid_predecessor");
  });
  it("bounds multibyte canonical scope bytes before hashing", () => {
    const m = missionFixture({ intent: { ...missionFixture().intent, scope: ["é".repeat(2500)] } });
    mustReject(buildManagerHandoffSnapshot(inputFixture({ mission: m })), "string_overflow");
  });
  it("maximal snapshot under all caps stays within 64KiB (byte_overflow unreachable under caps)", () => {
    const maxRef = `ref:${"x".repeat(223)}`;
    const result = mustOk(buildManagerHandoffSnapshot(inputFixture({
      ownership: Array.from({ length: 16 }, () => ({ taskId: "task-a", threadId: "t".repeat(128), runId: "r".repeat(128), attemptNumber: 1 })),
      pendingResults: Array.from({ length: 16 }, () => ({ taskId: "task-b", dispatchKey: "d".repeat(128), commandId: "c".repeat(128), disposition: "advanced" as const })),
      blockers: Array.from({ length: 16 }, (_, i) => ({ id: `b-${i}-${"i".repeat(120)}`, ref: maxRef })),
      nextActions: Array.from({ length: 16 }, (_, i) => ({ id: `n-${i}-${"i".repeat(120)}`, ref: maxRef })),
      resourceHolds: Array.from({ length: 16 }, (_, i) => ({ holdId: `h-${i}-${"i".repeat(120)}`, keepAliveRef: maxRef })),
      integration: { branch: "feature/handoff", buildRef: maxRef, commit: "a".repeat(64) },
      coverage: { coverage: "partial", candidate: "proposed", runtime: "active", reportRef: maxRef, candidateRef: maxRef },
      routePolicy: { ref: maxRef, revision: "123e4567-e89b-42d3-a456-426614174000#999" },
      deadline: { cursor: 42, ref: maxRef },
    })));
    expect(result.bytes.length).toBeLessThanOrEqual(HANDOFF_MAX_SERIALIZED_BYTES);
  });
});
