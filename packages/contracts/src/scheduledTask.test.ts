import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskListResult,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
  ScheduledTaskWatch,
  ScheduledTaskWatchInput,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeWatch = Schema.decodeUnknownSync(ScheduledTaskWatch);

it("reads legacy task lists and preserves the optional watcher support marker", () => {
  const decode = Schema.decodeUnknownSync(ScheduledTaskListResult);
  expect(decode({ tasks: [] })).toEqual({ tasks: [] });
  expect(decode({ tasks: [], supportsWatchers: true })).toEqual({
    tasks: [],
    supportsWatchers: true,
  });
  expect(decode({ tasks: [], supportsWatchers: false }).supportsWatchers).toBe(false);
});

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });
});

describe("scheduled task watches", () => {
  const decode = Schema.decodeUnknownSync(ScheduledTaskWatchInput);
  const watch = {
    source: {
      type: "http_json",
      url: "https://example.com/items",
      itemsPath: "",
      keyPath: "id",
    },
    filters: [{ path: "fields.status.name", op: "equals", value: "To Do" }],
    maxConcurrentRuns: 1,
  };

  it("accepts a write-only manual credential without trimming it", () => {
    const decodeSecret = Schema.decodeUnknownSync(ScheduledTaskUpsertInput.fields.watchSecret);
    expect(decodeSecret(" private-token ")).toBe(" private-token ");
    expect(() => decodeSecret("")).toThrow();
    expect(() => decodeSecret(null)).toThrow();
  });

  it("accepts Jira Cloud and HTTP JSON with private secret references", () => {
    expect(decode(watch)).toEqual(watch);
    const jira = {
      ...watch,
      source: {
        type: "jira",
        baseUrl: "https://example.atlassian.net",
        jql: "project = APP",
        auth: { type: "basic", username: "user@example.com", secretRef: "secret:request" },
      },
    };
    expect(decode(jira)).toEqual(jira);
    expect(
      decode({
        ...watch,
        source: { ...watch.source, auth: { type: "bearer", secretRef: "secret:request" } },
      }).source.auth,
    ).toEqual({ type: "bearer", secretRef: "secret:request" });
  });

  it("bounds concurrency and filters and rejects malformed rules", () => {
    for (const maxConcurrentRuns of [0, 5, 1.5]) {
      expect(() => decode({ ...watch, maxConcurrentRuns })).toThrow();
    }
    expect(decode({ ...watch, maxConcurrentRuns: 4 }).maxConcurrentRuns).toBe(4);
    for (const filters of [
      Array.from({ length: 17 }, () => ({ path: "id", op: "exists" })),
      [{ path: "", op: "exists" }],
      [{ path: "status", op: "in", value: [] }],
      [{ path: "status", op: "in", value: "To Do" }],
      [{ path: "status", op: "equals" }],
      [{ path: "status", op: "matches", value: "todo" }],
    ]) {
      expect(() => decode({ ...watch, filters })).toThrow();
    }
    expect(decode({ ...watch, filters: [] }).filters).toEqual([]);
    expect(
      decode({ ...watch, filters: [{ path: "label", op: "in", value: ["a,b", " To Do "] }] })
        .filters,
    ).toEqual([{ path: "label", op: "in", value: ["a,b", " To Do "] }]);
  });

  it("reads only credential summaries and never returns secret references or values", () => {
    const read = decodeWatch({
      ...watch,
      source: {
        ...watch.source,
        auth: {
          type: "bearer",
          hasSecret: true,
          secret: "private-value",
          secretRef: "private-ref",
        },
      },
      initializedAt: null,
      lastFiredAt: null,
      fireCount: 0,
      pendingCount: 0,
      activeRunCount: 0,
    });
    expect(read.source.auth).toEqual({ type: "bearer", hasSecret: true });
    expect(
      decode({
        ...watch,
        source: { ...watch.source, auth: { type: "bearer", secret: "private-value" } },
      }).source.auth,
    ).toEqual({ type: "bearer" });
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});
