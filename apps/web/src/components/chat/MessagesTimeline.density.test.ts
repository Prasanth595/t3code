import { describe, expect, it } from "vite-plus/test";
import { applyTimelineDensity, type MessagesTimelineRow } from "./MessagesTimeline.logic";

type WorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
const entry = (id: string, itemType: string) =>
  ({ id, itemType, createdAt: "2026-01-01T00:00:00Z" }) as unknown as WorkEntry;
const work = (
  id: string,
  entries: WorkEntry[],
  isExpandedToolGroup = false,
): MessagesTimelineRow => ({
  kind: "work",
  id,
  createdAt: "2026-01-01T00:00:00Z",
  groupedEntries: entries,
  isExpandedToolGroup,
});
const assistant = (id: string, showAssistantMeta: boolean) =>
  ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: { id, role: "assistant", runId: "run-1" },
    showAssistantMeta,
  }) as unknown as MessagesTimelineRow;

describe("applyTimelineDensity", () => {
  const rows = [
    work("w1", [entry("r1", "reasoning"), entry("c1", "command_execution")]),
    assistant("m1", false),
    work("w2", [entry("c2", "command_execution"), entry("c3", "command_execution")]),
    assistant("m2", true),
  ];

  it("is identity when both settings are off", () => {
    expect(applyTimelineDensity(rows, { compactWorkLog: false, hideReasoning: false })).toBe(rows);
  });

  it("hides reasoning and commentary, then compacts to one updating line", () => {
    const result = applyTimelineDensity(rows, { compactWorkLog: true, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["w2", "m2"]);
    const last = result[0] as Extract<MessagesTimelineRow, { kind: "work" }>;
    expect(last.groupedEntries.map((e) => e.id)).toEqual(["c3"]);
    expect(last.isExpandedToolGroup).toBe(false);
  });

  it("hideReasoning alone keeps tool rows and the final answer", () => {
    const result = applyTimelineDensity(rows, { compactWorkLog: false, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["w1", "w2", "m2"]);
  });

  it("hides live commentary as soon as the next step starts", () => {
    const live = [
      work("w1", [entry("c1", "command_execution")]),
      assistant("m1", false),
      work("w2", [entry("c2", "command_execution")]),
    ];
    const result = applyTimelineDensity(live, { compactWorkLog: true, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["w2"]);
  });

  it("keeps a terminal answer whose meta moved below trailing tools", () => {
    const settled = [
      assistant("m1", false),
      work("w1", [entry("c1", "command_execution")]),
      {
        kind: "assistant-meta",
        id: "assistant-meta:m1",
        createdAt: "2026-01-01T00:00:00Z",
        message: { id: "m1", role: "assistant", runId: "run-1" },
      } as unknown as MessagesTimelineRow,
    ];
    const result = applyTimelineDensity(settled, { compactWorkLog: false, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["m1", "w1", "assistant-meta:m1"]);
  });

  it("leaves a run the user expanded intact", () => {
    const expanded = [
      work("w1", [entry("c1", "command_execution"), entry("c2", "command_execution")], true),
      work("w2", [entry("c3", "command_execution")], true),
    ];
    const result = applyTimelineDensity(expanded, { compactWorkLog: true, hideReasoning: false });
    expect(result).toEqual(expanded);
  });
});
