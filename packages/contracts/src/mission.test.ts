import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Mission, MissionCommand, MissionEvent } from "./mission.ts";
import {
  MAX_MISSION_EXECUTION_ADMISSIONS,
  MissionExecution,
  emptyMissionExecution,
} from "./missionExecution.ts";

const decodeCommand = Schema.decodeUnknownSync(MissionCommand);

const decodeEvent = Schema.decodeUnknownSync(MissionEvent);

const encodeMission = Schema.encodeSync(Mission);

const decodeExecution = Schema.decodeUnknownSync(MissionExecution);
const decodeMission = Schema.decodeUnknownSync(Mission);

const OCCURRED_AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const missionFixture = () => ({
  schemaVersion: 1,
  id: "mission-1",
  revision: 0,
  teamId: "team-1",
  authorityEnvironmentId: "env-1",
  bindings: [
    {
      projectId: "project-1",
      workspaceRoot: "/tmp/project",
      baseCommit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
      ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
    },
    {
      projectId: "project-2",
      workspaceRoot: "/tmp/project-two",
      baseCommit: "b2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
      ancestry: ["b2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
    },
  ],
  intent: {
    outcome: "Ship the opt-in mission aggregate.",
    scope: ["contracts"],
    exclusions: ["persistence"],
    authorityRefs: [{ ...AUTHORITY }],
    acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
    decisions: [{ id: "d-1", text: "Small leaf module.", authority: { ...AUTHORITY } }],
  },
  integrationTarget: { summary: "Root store follow-up." },
  managers: { delivery: { threadId: "thread-1", epoch: 3 } },
  status: "active",
  tasks: [
    {
      id: "task-a",
      projectId: "project-1",
      title: "Define schemas",
      specHash: "hash-a1",
      dependencyHashes: [],
      dependencies: [],
      acceptanceIds: ["ac-1"],
      attempt: { attemptNumber: 1, receiptRef: "receipt-a" },
      updatedAt: OCCURRED_AT,
    },
    {
      id: "task-b",
      projectId: "project-2",
      title: "Define planner",
      specHash: "hash-b1",
      dependencyHashes: ["hash-a1"],
      dependencies: ["task-a"],
      acceptanceIds: ["ac-1"],
      attempt: { attemptNumber: 1, receiptRef: "receipt-b" },
      updatedAt: OCCURRED_AT,
    },
  ],
  updatedAt: OCCURRED_AT,
});

describe("mission wire schemas", () => {
  it("round-trips a multi-repository mission", () => {
    const decoded = decodeMission(missionFixture());
    const encoded = encodeMission(decoded);
    expect(encoded.bindings).toHaveLength(2);
    expect(decodeMission(encoded)).toEqual(decoded);
  });

  it("round-trips create and replace commands", () => {
    const create = decodeCommand({
      type: "mission.create",
      commandId: "cmd-1",
      mission: missionFixture(),
    });
    expect(create.type).toBe("mission.create");
    const replace = decodeCommand({
      type: "mission.replace",
      commandId: "cmd-2",
      expectedRevision: 0,
      epoch: 3,
      authority: { ...AUTHORITY },
      mission: { ...missionFixture(), revision: 1 },
    });
    expect(replace.type).toBe("mission.replace");
  });

  it("round-trips a revised event with admission splits", () => {
    const event = decodeEvent({
      sequence: 7,
      eventId: "event-7",
      aggregateKind: "mission",
      aggregateId: "mission-1",
      occurredAt: OCCURRED_AT,
      commandId: "cmd-2",
      metadata: {},
      type: "mission.revised",
      payload: {
        mission: { ...missionFixture(), revision: 1 },
        invalidatedAdmissionRefs: ["receipt-a"],
        preservedAdmissionRefs: ["receipt-b"],
      },
    });
    expect(event.type).toBe("mission.revised");
  });

  it("rejects a non-1 schema version at decode", () => {
    expect(() => decodeMission({ ...missionFixture(), schemaVersion: 2 })).toThrow();
  });

  it("rejects empty bindings at decode", () => {
    expect(() => decodeMission({ ...missionFixture(), bindings: [] })).toThrow();
  });

  it("decodes an omitted execution as backwards compatible", () => {
    const decoded = decodeMission(missionFixture());
    expect(decoded.execution).toBeUndefined();
  });

  it("round-trips bounded execution state", () => {
    const admission = {
      dispatchKey: '["mission-admission","team-1","env-1","mission-1","task-a",1,"write"]',
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      taskId: "task-a",
      attemptNumber: 1,
      operation: "write",
      requestDigest: "digest-1",
      admittedAtMs: 1_760_400_000_000,
      chosenRoute: {
        providerInstanceId: "codex_personal",
        modelId: "model-a",
        profile: "muse-focused high",
      },
      rejectedRoutes: [],
      accountVerifiedAtMs: 1_760_399_999_000,
      hostObservedAtMs: 1_760_399_995_000,
      repositoryObservedAtMs: 1_760_399_995_000,
      accountId: "acct-1",
      billingMode: "subscription",
      hostId: "test-host",
      bootId: "test-boot",
      hostThreadId: "thread-1",
      hostEpoch: 3,
      unknownUsageException: false,
      unknownUsageExceptionId: null,
      exceptionConsumptionRef: null,
    };
    const execution = decodeExecution({
      ...emptyMissionExecution(),
      admissions: [admission],
      writerClaims: [
        {
          scope: "/tmp/project/work",
          dispatchKey: admission.dispatchKey,
          missionId: "mission-1",
          taskId: "task-a",
          attemptNumber: 1,
          operation: "write",
        },
      ],
      consumedExceptionIds: ["ex-1"],
    });
    const decoded = decodeMission({ ...missionFixture(), execution });
    expect(decoded.execution).toEqual(execution);
    expect(encodeMission(decoded).execution).toEqual(execution);
  });

  it("rejects execution beyond the admission bound", () => {
    const admission = {
      dispatchKey: "key",
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      taskId: "task-a",
      attemptNumber: 1,
      operation: "write",
      requestDigest: "digest",
      admittedAtMs: 1,
      chosenRoute: {
        providerInstanceId: "codex_personal",
        modelId: "model-a",
        profile: "p",
      },
      rejectedRoutes: [],
      accountVerifiedAtMs: 1,
      hostObservedAtMs: 1,
      repositoryObservedAtMs: 1,
      accountId: "acct-1",
      billingMode: "subscription",
      hostId: "h",
      bootId: "b",
      hostThreadId: "thread-1",
      hostEpoch: 3,
      unknownUsageException: false,
      unknownUsageExceptionId: null,
      exceptionConsumptionRef: null,
    };
    expect(() =>
      decodeExecution({
        ...emptyMissionExecution(),
        admissions: Array.from({ length: MAX_MISSION_EXECUTION_ADMISSIONS + 1 }, () => ({
          ...admission,
        })),
      }),
    ).toThrow();
  });

  it("round-trips a mission.admission-reserved event", () => {
    const event = decodeEvent({
      sequence: 9,
      eventId: "event-9",
      aggregateKind: "mission",
      aggregateId: "mission-1",
      occurredAt: OCCURRED_AT,
      commandId: "cmd-9",
      metadata: {},
      type: "mission.admission-reserved",
      payload: {
        mission: { ...missionFixture(), revision: 1, execution: emptyMissionExecution() },
        dispatchKey: '["mission-admission","team-1","env-1","mission-1","task-a",1,"write"]',
        requestDigest: "digest-1",
      },
    });
    expect(event.type).toBe("mission.admission-reserved");
    if (event.type === "mission.admission-reserved") {
      expect(event.payload.mission.revision).toBe(1);
    }
  });
});
