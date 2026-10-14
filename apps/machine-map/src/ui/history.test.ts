import { describe, expect, it } from "vite-plus/test";
import type {
  MachineCommand,
  MachineMapDocument,
  MapActor,
  MapChange,
  MapRevision,
} from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow } from "../rules/map.ts";
import { lockdownChanges, LOCKDOWN_SUMMARY, PAUSE_SUMMARY } from "../rules/presets.ts";
import { MAC, machine, threeMachines, VPS, WIN } from "../rules/testMap.ts";
import {
  classifyRevision,
  groupHistory,
  groupSummary,
  historyEntries,
  matchesFilter,
  NO_FILTER,
  revisionDiff,
} from "./history.ts";

const owner: MapActor = { _tag: "owner", email: "me@example.com", device: "Mac · Chrome" };
const phone: MapActor = { _tag: "owner", email: "me@example.com", device: "iPhone · Safari" };
const agent: MapActor = { _tag: "agent", machineId: VPS, threadId: "t1", threadTitle: "Fix" };

let counter = 0;
/** A revision of `changes` on `map`, with the inverse that the portal records. */
function revision(
  map: MachineMapDocument,
  changes: ReadonlyArray<MapChange>,
  options: { actor?: MapActor; at?: string; summary?: string } = {},
): MapRevision {
  counter += 1;
  return {
    revision: counter,
    at: options.at ?? "2026-10-13T10:00:00.000Z",
    actor: options.actor ?? owner,
    summary: options.summary ?? `change ${counter}`,
    changes,
    inverse: applyChanges(map, changes).inverse,
  };
}

const map = threeMachines();
const arrowTo = (level: "none" | "read" | "admin") =>
  ({ _tag: "setArrow", arrow: { ...findArrow(map, MAC, VPS), level } }) as const;
const move = (x: number): MapChange => ({
  _tag: "putMachine",
  machine: { ...machine(MAC), position: { x, y: 0.5 } },
});

describe("classifyRevision (MM-715)", () => {
  it("tells raised and lowered access apart", () => {
    const raised = applyChanges(map, [arrowTo("admin")]).map;
    expect(classifyRevision(revision(map, [arrowTo("admin")]))).toBe("raise");
    expect(classifyRevision(revision(raised, [arrowTo("read")]))).toBe("lower");
    const role = { _tag: "putMachine", machine: { ...machine(WIN), mapRole: "edit" } } as const;
    expect(classifyRevision(revision(map, [role]))).toBe("raise");
  });

  it("reads the summaries that the portal writes for pause and lockdown", () => {
    const raised = applyChanges(map, [arrowTo("admin")]).map;
    const changes = lockdownChanges(raised);
    expect(classifyRevision(revision(raised, changes, { summary: PAUSE_SUMMARY }))).toBe("pause");
    expect(classifyRevision(revision(raised, changes, { summary: LOCKDOWN_SUMMARY }))).toBe(
      "lockdown",
    );
  });

  it("names expiries, hostnames, settings, moves and notes", () => {
    const expiry = revision(map, [arrowTo("none")], {
      actor: { _tag: "portal", reason: "expiry" },
    });
    expect(classifyRevision(expiry)).toBe("expiry");
    const host = {
      _tag: "putMachine",
      machine: { ...machine(MAC), hostname: "new.host" },
    } as const;
    expect(classifyRevision(revision(map, [host]))).toBe("join");
    const setting = {
      _tag: "setSetting",
      machineId: null,
      scope: "server",
      key: "theme",
      present: true,
      value: 1,
    } as const;
    expect(classifyRevision(revision(map, [setting]))).toBe("settings");
    expect(classifyRevision(revision(map, [move(0.2)]))).toBe("move");
    expect(
      classifyRevision(revision(map, [{ _tag: "placePair", a: MAC, b: VPS, offset: null }])),
    ).toBe("move");
    const note = {
      _tag: "putNote",
      note: { id: "n", text: "hi", color: "blue", position: { x: 0.5, y: 0.5 } },
    } as const;
    expect(classifyRevision(revision(map, [note]))).toBe("note");
    const withNote = applyChanges(map, [note]).map;
    const noteMove = {
      _tag: "putNote",
      note: { ...note.note, position: { x: 0.1, y: 0.1 } },
    } as const;
    expect(classifyRevision(revision(withNote, [noteMove]))).toBe("move");
  });

  it("lets access win over a move in the same revision", () => {
    expect(classifyRevision(revision(map, [move(0.3), arrowTo("admin")]))).toBe("raise");
  });
});

describe("groupHistory (MM-714)", () => {
  const command = (id: string, machineId = MAC, createdAt = "2026-10-13T09:00:00.000Z") =>
    ({
      id,
      machineId,
      input: { _tag: "stopAllAgents" },
      delivery: "online",
      actor: owner,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      expiresAt: "2026-10-20T09:00:00.000Z",
      result: null,
      error: null,
    }) satisfies MachineCommand;

  it("joins moves of one actor in a row, and nothing else", () => {
    const revisions = [
      revision(map, [move(0.1)], { at: "2026-10-13T10:05:00.000Z" }),
      revision(map, [{ _tag: "placePair", a: MAC, b: VPS, offset: { along: 0.4, aside: 0 } }], {
        at: "2026-10-13T10:04:00.000Z",
      }),
      revision(map, [{ _tag: "placePair", a: VPS, b: WIN, offset: { along: 0.4, aside: 0 } }], {
        at: "2026-10-13T10:03:00.000Z",
      }),
      revision(map, [move(0.2)], { at: "2026-10-13T10:02:00.000Z", actor: phone }),
      revision(map, [arrowTo("admin")], { at: "2026-10-13T10:01:00.000Z", actor: phone }),
      revision(map, [move(0.3)], { at: "2026-10-13T10:00:00.000Z", actor: phone }),
    ];
    const [day] = groupHistory(historyEntries(revisions, [], []));
    expect(day?.items.map((item) => (item._tag === "group" ? item.entries.length : 1))).toEqual([
      3, 1, 1, 1,
    ]);
    const group = day?.items[0];
    if (group?._tag !== "group") throw new Error("Expected a group.");
    expect(groupSummary(group, map)).toBe("Moved MAC and 2 cards · 3 moves");
  });

  it("joins the stop commands of one pause, and splits days", () => {
    const entries = historyEntries(
      [revision(map, [move(0.1)], { at: "2026-10-12T09:00:00.000Z" })],
      [command("c1"), command("c2", VPS), command("c3", WIN)],
      [],
    );
    const days = groupHistory(entries);
    expect(days).toHaveLength(2);
    const group = days[0]?.items[0];
    if (group?._tag !== "group") throw new Error("Expected a group.");
    expect(groupSummary(group, map)).toBe("Stop all agents on MAC, VPS and WIN");
  });
});

describe("matchesFilter (MM-716)", () => {
  const entries = historyEntries(
    [
      revision(map, [arrowTo("admin")], { actor: agent }),
      revision(map, [move(0.4)]),
      revision(map, [
        { _tag: "setSetting", machineId: null, scope: "server", key: "x", present: true, value: 1 },
      ]),
    ],
    [],
    [],
  );
  const kinds = (filter: Parameters<typeof matchesFilter>[1]) =>
    entries.filter((e) => matchesFilter(e, filter)).map((e) => e.kind);

  it("filters by machine, kind, actor and importance", () => {
    expect(kinds({ ...NO_FILTER, machineId: VPS })).toEqual(["raise"]);
    expect(kinds({ ...NO_FILTER, kind: "move" })).toEqual(["move"]);
    expect(kinds({ ...NO_FILTER, actor: `agent:${VPS}` })).toEqual(["raise"]);
    expect(kinds({ ...NO_FILTER, importantOnly: true })).toEqual(["raise"]);
    expect(kinds(NO_FILTER)).toHaveLength(3);
  });
});

describe("alert entries (MM-1505)", () => {
  const alert = (endedAt: string | null) => ({
    id: `a-${endedAt ?? "active"}`,
    machineId: WIN,
    kind: "offline" as const,
    startedAt: "2026-10-12T08:00:00.000Z",
    endedAt,
    value: 20,
    threshold: 15,
  });

  it("an ended alert gives a start and an end entry, an active one only a start", () => {
    const entries = historyEntries([], [], [alert("2026-10-12T09:00:00.000Z"), alert(null)]);
    expect(entries.map((e) => (e._tag === "alert" ? e.ended : null))).toEqual([true, false, false]);
    expect(entries.every((e) => e.kind === "alert")).toBe(true);
  });

  it("filters by the alert machine and the portal actor", () => {
    const entries = historyEntries([], [], [alert(null)]);
    expect(entries.filter((e) => matchesFilter(e, { ...NO_FILTER, machineId: WIN }))).toHaveLength(
      1,
    );
    expect(entries.filter((e) => matchesFilter(e, { ...NO_FILTER, machineId: VPS }))).toHaveLength(
      0,
    );
    expect(entries.filter((e) => matchesFilter(e, { ...NO_FILTER, actor: "portal" }))).toHaveLength(
      1,
    );
  });
});

describe("revisionDiff (MM-715)", () => {
  it("shows the level before and after, from the recorded inverse", () => {
    const rows = revisionDiff(revision(map, [arrowTo("admin")]), map);
    expect(rows).toEqual([{ label: "MAC uses VPS", before: "None", after: "Admin" }]);
  });

  it("names only the machine fields that changed", () => {
    const rows = revisionDiff(revision(map, [move(0.25)]), map);
    expect(rows.map((row) => row.label)).toEqual(["MAC place"]);
  });
});
