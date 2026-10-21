import type { ScheduledTask, ScheduledTaskWatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emptyWatchDraft,
  parseWatchDraft,
  watchDraft,
  watchActivityLabel,
  watchRuleLabel,
  watchSourceLabel,
  watchStatus,
  type ScheduledTaskWithWatch,
} from "./scheduledTaskWatch.ts";

describe("watch drafts", () => {
  it("creates an interval watch payload with a write-only credential", () => {
    expect(
      parseWatchDraft({
        ...emptyWatchDraft(),
        url: "https://acme.atlassian.net",
        jql: "project = OPS",
        authType: "basic",
        username: " user@example.com ",
        secret: " private-token ",
      }),
    ).toEqual({
      watch: {
        source: {
          type: "jira",
          baseUrl: "https://acme.atlassian.net",
          jql: "project = OPS",
          auth: { type: "basic", username: "user@example.com" },
        },
        filters: [],
        maxConcurrentRuns: 1,
      },
      watchSecret: " private-token ",
    });
  });

  it("roundtrips both sources, every operator, and list values CSV cannot preserve", () => {
    for (const source of [
      { type: "jira" as const, baseUrl: "https://acme.atlassian.net", jql: "project = OPS" },
      {
        type: "http_json" as const,
        url: "https://example.com/items",
        itemsPath: "data.items",
        keyPath: "key",
      },
    ]) {
      const saved: ScheduledTaskWatch = {
        ...watch,
        source: { ...source, auth: { type: "bearer", hasSecret: true } },
        maxConcurrentRuns: 4,
        filters: [
          { path: "fields.status.name", op: "equals", value: "To Do" },
          { path: "status", op: "notEquals", value: "" },
          { path: "id", op: "startsWith", value: "OPS-" },
          { path: "assignee", op: "exists" },
          { path: "label", op: "in", value: ["a,b", " To Do ", ""] },
          { path: "label", op: "in", value: ["[abc", "other"] },
          { path: "status", op: "in", value: ["Done", "Closed"] },
        ],
      };
      const draft = watchDraft(saved);
      expect(draft.secret).toBe("");
      expect(draft.filters.at(-1)!.value).toBe("Done, Closed");
      expect(parseWatchDraft(draft)).toEqual({
        watch: {
          source: { ...source, auth: { type: "bearer" } },
          filters: saved.filters,
          maxConcurrentRuns: 4,
        },
      });
    }
  });

  it("uses item paths without a webhook prefix and preserves scalar text", () => {
    const draft = {
      ...emptyWatchDraft(),
      sourceType: "http_json" as const,
      url: "https://example.com/items",
    };
    expect(
      parseWatchDraft({
        ...draft,
        filters: [
          { id: "one", path: " fields.status.name ", op: "equals", value: " To Do " },
          { id: "two", path: "status", op: "in", value: "Done, Closed" },
        ],
      }),
    ).toEqual({
      watch: {
        source: { type: "http_json", url: draft.url, itemsPath: "", keyPath: "id" },
        filters: [
          { path: "fields.status.name", op: "equals", value: " To Do " },
          { path: "status", op: "in", value: ["Done", "Closed"] },
        ],
        maxConcurrentRuns: 1,
      },
    });
  });

  it("rejects invalid fields, filters, and concurrency", () => {
    const valid = {
      ...emptyWatchDraft(),
      sourceType: "http_json" as const,
      url: "https://example.com/items",
    };
    for (const patch of [
      { url: "bad" },
      { url: "file:///tmp/feed" },
      { url: "https://user:password@example.com" },
      { keyPath: "" },
      { authType: "basic" as const, username: "" },
      { maxConcurrentRuns: "" },
      { maxConcurrentRuns: "0" },
      { maxConcurrentRuns: "5" },
      { maxConcurrentRuns: "1.5" },
      { filters: [{ id: "one", path: "", op: "exists" as const, value: "" }] },
      { filters: [{ id: "one", path: "status", op: "in" as const, value: "[]" }] },
      { filters: [{ id: "one", path: "status", op: "in" as const, value: "[1]" }] },
      {
        filters: Array.from({ length: 17 }, (_, id) => ({
          id: String(id),
          path: "id",
          op: "exists" as const,
          value: "",
        })),
      },
    ]) {
      expect(parseWatchDraft({ ...valid, ...patch })).toHaveProperty("error");
    }
  });

  it("omits credentials when auth is removed", () => {
    const result = parseWatchDraft({
      ...watchDraft(watch),
      authType: "none",
      secret: "stale-secret",
    });
    expect(result).toEqual({ watch: { source: watch.source, filters: [], maxConcurrentRuns: 1 } });
  });
});

const watch: ScheduledTaskWatch = {
  source: { type: "jira", baseUrl: "https://acme.atlassian.net", jql: "project = SECRET" },
  filters: [],
  maxConcurrentRuns: 1,
  initializedAt: "2026-10-21T10:00:00.000Z",
  lastFiredAt: null,
  fireCount: 0,
  pendingCount: 0,
  activeRunCount: 0,
};

const task = (patch: Partial<ScheduledTask>, watchPatch: Partial<ScheduledTaskWatch> = {}) =>
  ({
    enabled: true,
    lastRunStatus: "succeeded",
    ...patch,
    watch: { ...watch, ...watchPatch },
  }) as ScheduledTaskWithWatch;

describe("watchSourceLabel", () => {
  it("shows only the host, never the JQL, path, or query", () => {
    expect(watchSourceLabel(watch.source)).toBe("Jira · acme.atlassian.net");
    expect(
      watchSourceLabel({
        type: "http_json",
        url: "https://ci.example.com:8443/private/jobs?team=payroll",
        itemsPath: "jobs",
        keyPath: "id",
      }),
    ).toBe("JSON feed · ci.example.com:8443");
    expect(
      watchSourceLabel({ type: "http_json", url: "not a url", itemsPath: "", keyPath: "id" }),
    ).toBe("JSON feed");
  });
});

describe("watchRuleLabel", () => {
  it("names the first filter and counts the rest", () => {
    expect(watchRuleLabel([])).toBe("Any new item");
    expect(
      watchRuleLabel([
        { path: "fields.status.name", op: "in", value: ["Done", "Closed"] },
        { path: "fields.assignee", op: "exists" },
        { path: "key", op: "startsWith", value: "OPS-" },
      ]),
    ).toBe("fields.status.name is one of Done, Closed +2 more");
    expect(watchRuleLabel([{ path: "fields.assignee", op: "exists" }])).toBe(
      "fields.assignee exists",
    );
  });
});

describe("watchStatus", () => {
  it("puts pause before failure, and failure before baseline", () => {
    expect(watchStatus(task({ enabled: false, lastRunStatus: "failed" })).label).toBe("Paused");
    expect(watchStatus(task({ lastRunStatus: "failed" }, { initializedAt: null })).label).toBe(
      "Check failed",
    );
    expect(watchStatus(task({ lastRunStatus: "never" }, { initializedAt: null })).label).toBe(
      "Setting baseline",
    );
    expect(watchStatus(task({})).label).toBe("Watching");
  });
});

describe("watchActivityLabel", () => {
  it("lists running and queued work only when present", () => {
    expect(watchActivityLabel(watch)).toBe("0 runs started");
    expect(
      watchActivityLabel({
        ...watch,
        maxConcurrentRuns: 2,
        activeRunCount: 2,
        pendingCount: 3,
        fireCount: 1,
      }),
    ).toBe("2 of 2 running · 3 queued · 1 run started");
  });
});
