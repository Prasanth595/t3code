import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskListResult,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const encodeTaskList = Schema.encodeEffect(ScheduledTaskListResult);
// The task list as a client built before `useProjectDefaultModel` decodes it.
const { useProjectDefaultModel: _flag, ...olderClientTaskFields } = ScheduledTask.fields;
const decodeOlderClientList = Schema.decodeUnknownEffect(
  Schema.Struct({ tasks: Schema.Array(Schema.Struct(olderClientTaskFields)) }),
);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      ServerSettings.layerTest(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      ServerSettings.layerTest(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps a custom provider instance and the project default through a save", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      ServerSettings.layerTest(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        title: "Digest",
        prompt: "Write the digest.",
        enabled: false,
        schedule: { type: "webhook" },
        projectId: "project-model-round-trip",
        workspaceStrategy: { type: "root" },
        runtimeMode: "full-access",
        interactionMode: "default",
      };
      const explicit = {
        instanceId: "claudeWork",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      };
      yield* service.upsert(
        yield* decodeUpsertInput({ ...base, id: "task-explicit", modelSelection: explicit }),
      );
      yield* service.upsert(
        yield* decodeUpsertInput({
          ...base,
          id: "task-project-default",
          modelSelection: explicit,
          useProjectDefaultModel: true,
        }),
      );

      const { tasks } = yield* service.list();
      const byId = new Map(tasks.map((task) => [task.id, task]));
      expect(byId.get(ScheduledTaskId.make("task-explicit"))?.modelSelection).toEqual(explicit);
      const projectDefault = byId.get(ScheduledTaskId.make("task-project-default"));
      expect(projectDefault?.useProjectDefaultModel).toBe(true);
      // A client built before the flag decodes every task and sees a plain model.
      const olderClientList = yield* decodeOlderClientList(yield* encodeTaskList({ tasks }));
      expect(olderClientList.tasks).toHaveLength(2);
      // Rows keep their stored shape, so tasks saved before this change still decode.
      const rows = yield* sql<{ readonly id: string; readonly json: string }>`
        SELECT task_id AS id, model_selection_json AS json FROM scheduled_tasks ORDER BY task_id
      `;
      expect(rows.map((row) => JSON.parse(row.json))).toEqual([
        explicit,
        { _tag: "projectDefault" },
      ]);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("resolves a project default task at run time: the project, then the app default", () =>
  Effect.gen(function* () {
    const appDefault = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    };
    const projectDefault = {
      instanceId: ProviderInstanceId.make("claudeWork"),
      model: "claude-opus-5-5",
    };
    const launched: Array<ModelSelection> = [];
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input.modelSelection);
          return Effect.die(new Error("launch recorded"));
        },
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      ServerSettings.layerTest({
        defaultModelSelection: appDefault,
        providerInstances: {
          [ProviderInstanceId.make("claudeWork")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
          },
        },
        projectSettingsOverrides: {
          [ProjectId.make("project-with-default")]: { defaultModelSelection: projectDefault },
        },
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      for (const projectId of ["project-with-default", "project-without-default"]) {
        const { task } = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Digest",
            prompt: "Write the digest.",
            enabled: false,
            schedule: { type: "interval", everyMs: 3_600_000 },
            projectId,
            workspaceStrategy: { type: "root" },
            modelSelection: appDefault,
            useProjectDefaultModel: true,
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        yield* service.runNow({ id: task.id });
      }
      expect(launched).toEqual([projectDefault, appDefault]);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
