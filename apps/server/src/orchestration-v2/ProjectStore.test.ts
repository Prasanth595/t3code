import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityMemory from "../project/RepositoryIdentityMemory.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );
  },
);

it.layer(
  Layer.mergeAll(ProjectStore.layer, RepositoryIdentityMemory.layerSql).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
)("RepositoryIdentityMemory.layerSql", (it) => {
  const at = "2026-03-24T00:00:00.000Z";
  const identity: RepositoryIdentity = {
    canonicalKey: "example.test/owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@example.test:owner/repo.git",
    },
    displayName: "owner/repo",
    owner: "owner",
    name: "repo",
  };
  const base = (projectId: ProjectId, suffix: string) => ({
    sequence: 1,
    eventId: EventId.make(`event-${suffix}`),
    aggregateKind: "project" as const,
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  });
  const createProject = (projectId: ProjectId, workspaceRoot: string) =>
    Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
      projects.apply({
        ...base(projectId, `created-${projectId}`),
        type: "project.created",
        payload: {
          projectId,
          title: "repo",
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      }),
    );

  it.effect("recalls the identity remembered for a root, only while its project is active", () =>
    Effect.gen(function* () {
      const memory = yield* RepositoryIdentityMemory.RepositoryIdentityMemory;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectId = ProjectId.make("project-memory-active");
      const workspaceRoot = "/repo/feature";

      assert.isTrue(Option.isNone(yield* memory.recall(workspaceRoot)));
      yield* memory.remember(workspaceRoot, identity);
      assert.isTrue(Option.isNone(yield* memory.recall(workspaceRoot)), "no row to remember on");

      yield* createProject(projectId, workspaceRoot);
      yield* memory.remember(workspaceRoot, identity);
      assert.deepStrictEqual(Option.getOrNull(yield* memory.recall(workspaceRoot)), identity);

      yield* projects.apply({
        ...base(projectId, "deleted"),
        type: "project.deleted",
        payload: { projectId, deletedAt: at },
      });
      assert.isTrue(Option.isNone(yield* memory.recall(workspaceRoot)));
    }),
  );

  it.effect("forgets the identity when the project moves to another folder", () =>
    Effect.gen(function* () {
      const memory = yield* RepositoryIdentityMemory.RepositoryIdentityMemory;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectId = ProjectId.make("project-memory-moved");
      const workspaceRoot = "/repo/old";

      yield* createProject(projectId, workspaceRoot);
      yield* memory.remember(workspaceRoot, identity);
      yield* projects.apply({
        ...base(projectId, "renamed"),
        type: "project.meta-updated",
        payload: { projectId, title: "renamed", updatedAt: at },
      });
      assert.deepStrictEqual(
        Option.getOrNull(yield* memory.recall(workspaceRoot)),
        identity,
        "a title change keeps it",
      );

      yield* projects.apply({
        ...base(projectId, "moved"),
        type: "project.meta-updated",
        payload: { projectId, workspaceRoot: "/repo/new", updatedAt: at },
      });
      assert.isTrue(Option.isNone(yield* memory.recall(workspaceRoot)));
      assert.isTrue(Option.isNone(yield* memory.recall("/repo/new")));
    }),
  );
});
