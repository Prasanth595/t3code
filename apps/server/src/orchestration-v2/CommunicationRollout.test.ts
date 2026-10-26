import { expect, it } from "vite-plus/test";

import { communicationDiagnostics, communicationLanesPaused } from "./CommunicationRollout.ts";

it("requires an explicit operating switch before pausing lane delivery", () => {
  expect(communicationLanesPaused({})).toBe(false);
  expect(communicationLanesPaused({ T3_COMMUNICATION_LANES_PAUSED: "0" })).toBe(false);
  expect(communicationLanesPaused({ T3_COMMUNICATION_LANES_PAUSED: "1" })).toBe(true);
  expect(communicationLanesPaused({ T3_COMMUNICATION_LANES_PAUSED: "TRUE" })).toBe(true);
});

it("exports queue and receipt metadata without transcript text", () => {
  const projection = {
    thread: { id: "thread:diagnostic", communicationLanesEnabled: true },
    messages: [
      {
        id: "message:human",
        text: "private user question",
        communication: {
          classification: "verified",
          route: { port: "user.in" },
          producer: { kind: "human" },
          delivery: { state: "provider_accepted" },
        },
      },
      {
        id: "message:internal",
        text: "private child result",
        communication: {
          classification: "verified",
          route: { port: "internal.in" },
          producer: { kind: "agent" },
          delivery: { state: "accepted" },
        },
      },
      {
        id: "message:published",
        text: "private published answer",
        communication: { route: { port: "user.out" } },
      },
    ],
    runs: [
      { id: "run:internal", status: "queued", ordinal: 1, userMessageId: "message:internal" },
      { id: "run:human", status: "queued", ordinal: 2, userMessageId: "message:human" },
    ],
  } as never;
  const diagnostics = communicationDiagnostics(projection, true, 0, 1);
  expect(diagnostics.queuedUserRuns).toBe(1);
  expect(diagnostics.queuedInternalRuns).toBe(1);
  expect(diagnostics.internalDeliveryPaused).toBe(true);
  expect(diagnostics.providerAcceptedInputs).toBe(1);
  expect(diagnostics.acceptedInputs).toBe(1);
  expect(diagnostics.publishedUserOutputs).toBe(1);
  expect(diagnostics.pending).toHaveLength(1);
  expect(diagnostics.nextCursor).toBe(1);
  expect(JSON.stringify(diagnostics)).not.toContain("private");
});
