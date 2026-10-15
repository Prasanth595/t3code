import {
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveHandoffEndpoints,
  resolvePendingHandoff,
  type HandoffTimelineRun,
} from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const startedAt = "2026-10-11T00:00:00Z";
const projection = {
  runs: [{ ...run("source", 1, from, "source"), startedAt, status: "completed" }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });
  it("stays hidden until a run has history to hand off", () => {
    const firstRun = (status: string) =>
      ({
        runs: [{ ...run("source", 1, from, "source"), startedAt, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    for (const status of ["running", "cancelled", "rolled_back"]) {
      expect(
        resolvePendingHandoff(firstRun(status), { instanceId: to, model: "first" }, []),
      ).toBeNull();
    }
  });
  it("treats a later run as history when earlier runs are outside the loaded window", () => {
    const windowed = {
      runs: [{ ...run("current", 5, from, "source"), startedAt, status: "running" }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(resolvePendingHandoff(windowed, { instanceId: to, model: "next" }, [])?.from).toEqual([
      { instanceId: from, model: "source" },
    ]);
    // Every earlier run is loaded and none produced conversation.
    const afterFailedStart = {
      runs: [
        { ...run("failed", 1, from, "source"), startedAt: null, status: "failed" },
        { ...run("current", 2, from, "source"), startedAt, status: "running" },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(afterFailedStart, { instanceId: to, model: "next" }, []),
    ).toBeNull();
  });
  it("hands off from the latest started run, not the latest finished one", () => {
    const withLaterRun = (status: string, laterStartedAt: string | null) =>
      ({
        runs: [
          ...projection.runs,
          { ...run("later", 2, to, "later"), startedAt: laterStartedAt, status },
        ],
      }) as unknown as OrchestrationV2ThreadProjection;
    // A running handoff on the new provider is the source for the next send.
    expect(
      resolvePendingHandoff(
        withLaterRun("running", startedAt),
        { instanceId: to, model: "later" },
        [],
      ),
    ).toBeNull();
    expect(
      resolvePendingHandoff(
        withLaterRun("running", startedAt),
        { instanceId: from, model: "source" },
        [],
      )?.from,
    ).toEqual([{ instanceId: to, model: "later" }]);
    // A handoff that failed before starting never reached the new provider.
    expect(
      resolvePendingHandoff(
        withLaterRun("failed", null),
        { instanceId: from, model: "source" },
        [],
      ),
    ).toBeNull();
  });
  it("only previews a same-provider model change when it needs a fresh native thread", () => {
    const providers = [
      { instanceId: from, requiresNewThreadForModelChange: true },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "other" }, providers)?.to.model,
    ).toBe("other");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers),
    ).toBeNull();
  });
});
