import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScheduledTask,
  type ServerConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import {
  scheduledTaskDefaultModel,
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
  createDraft,
  editDraft,
  hasScheduledTaskDraftChanges,
  watchFieldsFromDraft,
  withDraftProject,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
  });

  it("round-trips dedupe settings and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 3600,
    };
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, dedupe } });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a webhook signature on save without sending a secret", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
    };
    const saved = scheduleFromDraft(
      scheduleDraftForTask({ schedule: { type: "webhook", signature } }),
    );
    expect(saved).toEqual({ type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} });
    expect(saved?.type === "webhook" && saved.signature && "secret" in saved.signature).toBe(false);
  });

  it("round-trips webhook filters and refuses an invalid one", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.label.name", op: "in", value: ["needs review", "agent:fix"] },
    ] as const;
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, filters } });
    // Untouched rows are left out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft(draft)).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(1) })).toMatchObject({
      filters: filters.slice(1),
    });
    expect(
      scheduleFromDraft({ ...draft, filters: [{ id: "f1", path: "", op: "exists", value: "" }] }),
    ).toBeNull();
  });
});

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it.each([
    ["1.5", 90_000],
    [String(60_001 / 60_000), 60_001],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = scheduledTaskDefaultModel;
  it("prefers the project's configured model", () => {
    expect(resolve(config, { id: projectId, defaultModelSelection: projectSelection })).toEqual(
      projectSelection,
    );
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: projectSelection },
            },
          },
        },
        { id: projectId },
      ),
    ).toEqual(projectSelection);
  });
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
  it("does not choose an implicit model on a disabled provider", () => {
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
          },
          providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
        },
        null,
      ),
    ).toBeNull();
  });
});

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});

describe("watcher drafts", () => {
  const watch = {
    source: {
      type: "jira",
      baseUrl: "https://example.atlassian.net",
      jql: "project = T3",
      auth: { type: "basic", username: "bot@example.com", hasSecret: true },
    },
    filters: [{ path: "fields.status.name", op: "equals", value: "Done" }],
    maxConcurrentRuns: 2,
    initializedAt: null,
    lastFiredAt: null,
    fireCount: 0,
    pendingCount: 0,
    activeRunCount: 0,
  } as const;
  const task = {
    id: "task",
    threadId: "thread",
    title: "Watch Jira",
    prompt: "Fix it",
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
    enabled: true,
    schedule: { type: "interval", everyMs: 120_000 },
    workspaceStrategy: { type: "root" },
    runtimeMode: "full-access",
    watch,
  } as unknown as ScheduledTask;

  it("reopens a watcher with its source and rule and saves it unchanged without a secret", () => {
    const draft = editDraft(task);
    expect(draft.schedule.mode).toBe("watch");
    expect(draft.threadId).toBe("thread");
    expect(scheduleFromDraft(draft.schedule)).toEqual({ type: "interval", everyMs: 120_000 });
    expect(watchFieldsFromDraft(draft)).toEqual({
      watch: {
        source: {
          type: "jira",
          baseUrl: watch.source.baseUrl,
          jql: watch.source.jql,
          auth: { type: "basic", username: "bot@example.com" },
        },
        filters: watch.filters,
        maxConcurrentRuns: 2,
      },
    });
  });

  it("sends a typed secret only for the watcher", () => {
    const draft = editDraft(task);
    const typed = {
      ...draft,
      schedule: { ...draft.schedule, watch: { ...draft.schedule.watch, secret: " token " } },
    };
    expect(hasScheduledTaskDraftChanges(draft, typed)).toBe(true);
    expect(watchFieldsFromDraft(typed)).toMatchObject({ watchSecret: " token " });
  });

  it("removes the watcher when switched to a timer and leaves ordinary tasks alone", () => {
    const draft = editDraft(task);
    expect(
      watchFieldsFromDraft({ ...draft, schedule: { ...draft.schedule, mode: "interval" } }),
    ).toEqual({
      watch: null,
    });
    expect(watchFieldsFromDraft(createDraft(null, null))).toEqual({});
    expect(
      watchFieldsFromDraft(editDraft({ ...task, watch: undefined } as unknown as ScheduledTask)),
    ).toEqual({});
  });

  it("drops the thread binding when the project changes", () => {
    const draft = editDraft(task);
    expect(withDraftProject(draft, draft.projectId!, null, false).threadId).toBe("thread");
    expect(withDraftProject(draft, ProjectId.make("other"), null, false).threadId).toBeNull();
  });

  it("rejects a watcher with a sub-minute check interval", () => {
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "watch", intervalMinutes: "0.5" }),
    ).toBeNull();
  });
});
