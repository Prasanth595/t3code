import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Mission, MissionCommand, MissionEvent } from "./mission.ts";

const decodeCommand = Schema.decodeUnknownSync(MissionCommand);

const decodeEvent = Schema.decodeUnknownSync(MissionEvent);

const encodeMission = Schema.encodeSync(Mission);

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
});
