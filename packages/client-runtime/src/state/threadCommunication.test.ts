import { expect, it } from "vite-plus/test";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

import {
  communicationCorrelationLabel,
  communicationDeliveryLabel,
  coordinationItemHeader,
  coordinationItemPreview,
  coordinationItemText,
  coordinationTurnItems,
  isCoordinationTurnItem,
  pendingDeliveryLabel,
  runFinishedWithoutUserUpdate,
} from "./threadCommunication.ts";

const row = (item: Record<string, unknown>) =>
  ({ item: { runId: "run", ...item } }) as unknown as OrchestrationV2ProjectedTurnItem;
const route = (port: string) => ({ route: { port } });

it("keeps only explicit user routes and control items in the enabled conversation", () => {
  const rows = [
    row({ id: "legacy", type: "assistant_message", text: "unaddressed" }),
    row({ id: "human", type: "assistant_message", communication: route("user.out") }),
    row({ id: "asked", type: "user_message", communication: route("user.in") }),
    row({ id: "internal", type: "assistant_message", communication: route("internal.out") }),
    row({ id: "cmd", type: "command_execution", input: "ls" }),
    row({ id: "think", type: "reasoning", text: "hmm" }),
    row({ id: "note", type: "notification", summary: "Child done" }),
    row({ id: "sys", type: "system_notice", message: "notice" }),
    row({ id: "approve", type: "approval_request" }),
    row({ id: "ask", type: "user_input_request" }),
    row({ id: "secret", type: "secret_request" }),
    row({ id: "err", type: "error" }),
    row({ id: "err-internal", type: "error", communication: route("internal.out") }),
    row({ id: "plan", type: "proposed_plan" }),
    row({ id: "ckpt", type: "checkpoint" }),
  ];
  const ids = (list: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
    list.map(({ item }) => item.id);

  expect(coordinationTurnItems(rows, false)).toEqual([]);
  expect(ids(coordinationTurnItems(rows, true))).toEqual([
    "legacy",
    "internal",
    "cmd",
    "think",
    "note",
    "sys",
  ]);
  expect(isCoordinationTurnItem(rows[1]!.item, true)).toBe(false);
  expect(isCoordinationTurnItem(rows[2]!.item, true)).toBe(false);
  expect(isCoordinationTurnItem(rows[8]!.item, true)).toBe(false);
  expect(isCoordinationTurnItem(rows[4]!.item, false)).toBe(false);
});

it("previews non-message work concisely and keeps the body for expansion", () => {
  const cmd = row({ id: "c", type: "command_execution", input: "pnpm test", output: "ok" }).item;
  const tool = row({ id: "t", type: "dynamic_tool", toolName: "grep", input: { q: 1 } }).item;
  const edit = row({ id: "e", type: "file_change", fileName: "a.ts" }).item;
  const long = row({ id: "l", type: "reasoning", text: "x".repeat(400) }).item;

  expect(coordinationItemPreview(cmd)).toBe("$ pnpm test");
  expect(coordinationItemText(cmd)).toBe("$ pnpm test\n\nok");
  expect(coordinationItemPreview(tool)).toBe("Tool: grep");
  expect(coordinationItemPreview(edit)).toBe("Edited a.ts");
  expect(coordinationItemPreview(long)).toHaveLength(160);
  expect(coordinationItemHeader(cmd)).toBe("unclassified · command execution");
  expect(
    coordinationItemHeader(
      row({
        id: "i",
        type: "assistant_message",
        communication: {
          route: { port: "internal.out" },
          producer: { kind: "agent" },
          delivery: { state: "pending" },
          replyTo: "m1",
        },
      }).item,
    ),
  ).toBe("internal.out · assistant message · agent · Pending delivery · reply to m1");
});

it("reports a completed run that published nothing to the user", () => {
  const finished = (rows: OrchestrationV2ProjectedTurnItem[]) =>
    runFinishedWithoutUserUpdate(rows, "run" as never, "completed");

  expect(
    finished([row({ type: "assistant_message", text: "answer", communication: undefined })]),
  ).toBe(true);
  expect(
    finished([row({ type: "assistant_message", text: "", communication: route("internal.out") })]),
  ).toBe(true);
  expect(
    finished([
      row({
        type: "notification",
        summary: "Coordination activity",
        communication: route("internal.out"),
      }),
    ]),
  ).toBe(true);
  expect(
    finished([
      row({ type: "assistant_message", text: "a" }),
      row({ type: "assistant_message", text: "b", communication: route("user.out") }),
    ]),
  ).toBe(false);
  expect(finished([row({ type: "command_execution", input: "ls" })])).toBe(false);
  expect(finished([row({ type: "assistant_message", text: "  " })])).toBe(false);
  expect(
    finished([
      row({ type: "user_message", runId: "run:request", communication: route("user.in") }),
      row({ type: "assistant_message", runId: "run:request", communication: route("user.out") }),
      row({
        type: "notification",
        summary: "Coordination activity",
        communication: route("internal.out"),
      }),
    ]),
  ).toBe(false);
  expect(
    finished([
      row({ type: "assistant_message", runId: "run:request", communication: route("user.out") }),
      row({ type: "user_message", runId: "run:next", communication: route("user.in") }),
      row({
        type: "notification",
        summary: "Coordination activity",
        communication: route("internal.out"),
      }),
    ]),
  ).toBe(true);
  expect(
    runFinishedWithoutUserUpdate(
      [row({ type: "assistant_message", text: "a" })],
      "run" as never,
      "running",
    ),
  ).toBe(false);
});

it("distinguishes intake from provider consumption", () => {
  expect(communicationDeliveryLabel({ state: "accepted" })).toBe("Accepted");
  expect(communicationDeliveryLabel({ state: "offered" })).toBe("Offered to provider");
  expect(communicationDeliveryLabel({ state: "consumption_unknown" })).toBe(
    "Provider consumption unknown",
  );
  expect(communicationDeliveryLabel(undefined)).toBeNull();
});

it("hides settled delivery and labels reply correlation", () => {
  expect(pendingDeliveryLabel({ state: "consumed" })).toBeNull();
  expect(pendingDeliveryLabel({ state: "pending" })).toBe("Pending delivery");
  expect(communicationCorrelationLabel({ replyTo: "m1" } as never)).toBe("reply to m1");
  expect(communicationCorrelationLabel({ causationId: "c1" } as never)).toBe("caused by c1");
  expect(communicationCorrelationLabel(undefined)).toBeNull();
});
