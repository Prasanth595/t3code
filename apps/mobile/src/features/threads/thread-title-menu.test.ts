import { describe, expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadTitleMenu, threadTitleSnoozeUntil } from "./thread-title-menu";

const now = new Date("2026-10-18T12:00:00.000Z");
const capabilities = {
  threadSettlement: true,
  threadSnooze: true,
  threadPinning: true,
  threadTitleRegeneration: true,
};
const thread = makeThreadShellFixture();
const menu = (overrides: Partial<Parameters<typeof buildThreadTitleMenu>[0]> = {}) =>
  buildThreadTitleMenu({
    thread,
    capabilities,
    canOperate: true,
    hasQueuedMessages: false,
    now,
    ...overrides,
  });
const ids = (overrides: Partial<Parameters<typeof buildThreadTitleMenu>[0]> = {}) =>
  menu(overrides).map((action) => action.id);

describe("thread title actions", () => {
  it("preserves the displayed snooze instant when selection crosses midnight", () => {
    const beforeMidnight = new Date("2026-10-18T23:59:00.000Z");
    const actions = menu({ now: beforeMidnight });
    const preset = actions
      .find((action) => action.id === "snooze")
      ?.subactions?.find((action) => action.id !== "snooze:custom");
    expect(preset?.id).toBeDefined();
    const until = preset!.id!.slice("snooze:".length);
    expect(threadTitleSnoozeUntil(preset!.id!, new Date(beforeMidnight.getTime() + 120_000))).toBe(
      until,
    );
    expect(threadTitleSnoozeUntil(preset!.id!, new Date(Date.parse(until) + 1))).toBeNull();
  });
  it("keeps a read-only connection from offering mutations", () => {
    expect(ids({ canOperate: false })).toEqual(["copy-thread-id"]);
  });
  it("omits unsupported lifecycle and title regeneration commands on older servers", () => {
    expect(ids({ capabilities: undefined })).toEqual(["rename", "copy-thread-id", "delete"]);
  });
  it("offers reverse actions after settling, pinning and snoozing", () => {
    const result = ids({
      thread: {
        ...thread,
        settledOverride: "settled",
        pinnedAt: now.toISOString(),
        snoozedAt: now.toISOString(),
        snoozedUntil: "2026-10-19T12:00:00.000Z",
      },
    });
    expect(result).toContain("unsettle");
    expect(result).toContain("unpin");
    expect(result).toContain("unsnooze");
    expect(result).not.toContain("settle");
    expect(result).not.toContain("pin");
    expect(result).not.toContain("snooze");
  });
  it("treats a locally queued message as active even before its settled shell updates", () => {
    expect(
      ids({ thread: { ...thread, settledOverride: "settled" }, hasQueuedMessages: true }),
    ).toContain("settle");
    expect(
      ids({ thread: { ...thread, settledOverride: "settled" }, hasQueuedMessages: true }),
    ).not.toContain("unsettle");
  });
  it("cannot snooze a thread waiting for a response", () => {
    expect(ids({ thread: { ...thread, hasPendingApprovals: true } })).not.toContain("snooze");
    expect(ids({ thread: { ...thread, hasPendingUserInput: true } })).not.toContain("snooze");
  });
  it("returns snooze after expiry and provides future presets", () => {
    const actions = menu({ thread: { ...thread, snoozedUntil: "2026-10-17T12:00:00.000Z" } });
    expect(actions.some((action) => action.id === "unsnooze")).toBe(false);
    const snooze = actions.find((action) => action.id === "snooze");
    expect(snooze?.subactions?.length).toBeGreaterThan(1);
    expect(snooze?.subactions?.at(-1)?.id).toBe("snooze:custom");
  });
  it("disables title regeneration while it is running and retains destructive confirmation semantics", () => {
    const actions = menu({
      thread: {
        ...thread,
        titleRegeneration: { requestId: "request-1", startedAt: now.toISOString() },
      },
    });
    expect(actions.find((action) => action.id === "regenerate-title")?.attributes?.disabled).toBe(
      true,
    );
    expect(actions.find((action) => action.id === "delete")?.attributes?.destructive).toBe(true);
  });
});
