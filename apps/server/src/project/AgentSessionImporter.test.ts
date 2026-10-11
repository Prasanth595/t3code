import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          findNativeSessionOwner: () => Effect.succeed(null),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

it.effect("places a session active so the sidebar auto-settle setting can decide", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const updatedAt = "2026-10-01T00:00:00.000Z";
  const session = (providerSessionId: string): AgentSessionScanner.AgentSessionRecentThread => ({
    _tag: "Importable",
    source: {
      provider: "codex",
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: Date.parse(updatedAt),
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: "codex",
      providerInstanceId,
      providerSessionId,
      title: providerSessionId,
      model: "gpt-5.4",
      createdAt: updatedAt,
      updatedAt,
      messages: [{ role: "user", text: "Hello", createdAt: updatedAt }],
    },
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentSessionScanner.AgentSessionScanner,
          AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () => Stream.fromIterable([session("quiet"), session("fresh")]),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          findNativeSessionOwner: () => Effect.succeed(null),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.fail(
              new Orchestrator.OrchestratorProjectionError({
                threadId: ThreadId.make("import:codex:missing"),
              }),
            ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 2,
      skippedCount: 0,
    });
    const created = writes.flatMap((events) =>
      events.filter((event) => event.type === "thread.created"),
    );
    expect(created.map((event) => event.payload.id)).toEqual([
      ThreadId.make("import:codex:quiet"),
      ThreadId.make("import:codex:fresh"),
    ]);
    expect(created[0]?.payload).toMatchObject({
      projectId,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lineage: { relationshipToParent: null },
    });
    expect(created[1]?.payload).toMatchObject({
      projectId,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lineage: { relationshipToParent: null },
    });
  }).pipe(Effect.provide(layerTest));
});

it.effect("does not place a session that already belongs to another thread", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentSessionScanner.AgentSessionScanner,
          AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () =>
              Stream.succeed({
                _tag: "Importable",
                source: {
                  provider: "codex",
                  providerInstanceId,
                  providerSessionId,
                  filePath: "/tmp/native-codex-thread.jsonl",
                  size: 100,
                  mtimeMs: 2,
                  device: 3,
                  inode: 4,
                  birthtimeMs: 1,
                },
                thread: {
                  source: "codex",
                  providerInstanceId,
                  providerSessionId,
                  title: "Already open",
                  model: "gpt-5.4",
                  createdAt: "2026-10-11T00:00:00.000Z",
                  updatedAt: "2026-10-11T00:00:00.000Z",
                  messages: [],
                },
              }),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          findNativeSessionOwner: () => Effect.succeed(ThreadId.make("thread-already-open")),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(writes).toEqual([]);
  }).pipe(Effect.provide(layerTest));
});
