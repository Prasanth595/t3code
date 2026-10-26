import { expect, it } from "vite-plus/test";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

import {
  coordinationMessageLabel,
  coordinationRowLabel,
  isEmptyCoordinationMessage,
  coordinationNotificationNeedsDetail,
  coordinationNotificationWithDetail,
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
  const ids = (lanesEnabled: boolean) =>
    rows
      .filter(({ item }) => isCoordinationTurnItem(item, lanesEnabled))
      .map(({ item }) => item.id);

  expect(ids(false)).toEqual([]);
  expect(ids(true)).toEqual(["legacy", "internal", "cmd", "think", "note", "sys", "ckpt"]);
  expect(isCoordinationTurnItem(rows[1]!.item, true)).toBe(false);
  expect(isCoordinationTurnItem(rows[2]!.item, true)).toBe(false);
  expect(isCoordinationTurnItem(rows[8]!.item, true)).toBe(false);
  expect(isCoordinationTurnItem(rows[4]!.item, false)).toBe(false);
});

it("labels agent traffic in plain language and folds fetched text into the row", () => {
  const envelope = (port: string, extra: Record<string, unknown>) =>
    ({ route: { port, ...extra }, producer: { kind: "agent" } }) as never;
  expect(coordinationMessageLabel(envelope("internal.in", {}))).toBe("Message from agent");
  expect(coordinationMessageLabel(envelope("internal.out", { audience: "agent" }))).toBe(
    "Message to agent",
  );
  expect(coordinationMessageLabel(envelope("internal.out", { audience: "coordinator" }))).toBe(
    "Agent note",
  );
  expect(coordinationMessageLabel(envelope("user.out", { audience: "human" }))).toBeNull();
  expect(coordinationMessageLabel(undefined)).toBeNull();

  const wire = row({
    id: "n",
    type: "notification",
    summary: "Coordination activity",
    communication: envelope("internal.in", {}),
  }).item;
  const fetched = row({ id: "n", type: "user_message", text: "Orbit risks maintenance." }).item;
  expect(coordinationNotificationNeedsDetail(wire)).toBe(true);
  expect(coordinationNotificationWithDetail(wire, fetched)).toMatchObject({
    type: "notification",
    detail: "Orbit risks maintenance.",
  });
  expect(coordinationNotificationWithDetail(wire, undefined)).toBeNull();
  const plain = row({ id: "p", type: "notification", summary: "Child done" }).item;
  expect(coordinationNotificationNeedsDetail(plain)).toBe(false);
  expect(coordinationNotificationWithDetail(plain, fetched)).toBeNull();
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

it("badges only delivery states the user waits on or must act on", () => {
  expect(pendingDeliveryLabel({ state: "consumed" })).toBeNull();
  expect(pendingDeliveryLabel({ state: "provider_accepted" })).toBeNull();
  expect(pendingDeliveryLabel({ state: "consumption_unknown" })).toBeNull();
  expect(pendingDeliveryLabel({ state: "pending" })).toBe("Waiting to send");
  expect(pendingDeliveryLabel({ state: "failed" })).toBe("Failed to send");
  expect(pendingDeliveryLabel(undefined)).toBeNull();
});

it("previews coordination rows and drops empty ones", () => {
  const inbound = { route: { port: "internal.in" }, producer: { kind: "agent" } };
  const note = (summary: string, detail?: string) =>
    row({
      type: "notification",
      summary,
      communication: inbound,
      ...(detail === undefined ? {} : { detail }),
    }).item;
  expect(coordinationRowLabel(note("Orbit risks maintenance."))).toBe(
    "Message from agent: Orbit risks maintenance.",
  );
  expect(coordinationRowLabel(note("Coordination activity"))).toBe("Message from agent");
  expect(coordinationRowLabel(row({ type: "assistant_message", text: "Plan\nmore" }).item)).toBe(
    "Agent note: Plan",
  );
  expect(
    coordinationRowLabel(row({ type: "notification", summary: "Child done" }).item),
  ).toBeNull();

  expect(isEmptyCoordinationMessage(note("Coordination activity", ""))).toBe(true);
  expect(isEmptyCoordinationMessage(note("Orbit risks maintenance."))).toBe(false);
  expect(
    isEmptyCoordinationMessage(row({ type: "notification", summary: "x", detail: "" }).item),
  ).toBe(false);
  expect(isEmptyCoordinationMessage(row({ type: "assistant_message", text: " " }).item)).toBe(true);
});
