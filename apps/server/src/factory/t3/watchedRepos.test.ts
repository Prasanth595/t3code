// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real checkouts and read them back.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EventId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import * as WatchedRepos from "./watchedRepos.ts";

const tempDir = useTempDirs();

const FACTORY_CONFIG = "factory:\n  base: main\n";

const github = (owner: string, name: string): RepositoryIdentity => ({
  canonicalKey: `github.com/${owner}/${name}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://github.com/${owner}/${name}.git`,
  },
  provider: "github",
  owner,
  name,
});

const WIDGETS = github("acme", "widgets");
const GADGETS = github("acme", "gadgets");

const projectEvent = (
  type: "project.created" | "project.deleted",
  id: string,
  workspaceRoot: string,
  sequence: number,
) =>
  type === "project.created"
    ? ({
        sequence,
        eventId: EventId.make(`event:${id}:created`),
        aggregateKind: "project",
        aggregateId: ProjectId.make(id),
        occurredAt: "2026-10-03T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: ProjectId.make(id),
          title: `Title of ${id}`,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
      } as const)
    : ({
        sequence,
        eventId: EventId.make(`event:${id}:deleted`),
        aggregateKind: "project",
        aggregateId: ProjectId.make(id),
        occurredAt: "2026-10-03T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId: ProjectId.make(id), deletedAt: "2026-10-03T00:00:00.000Z" },
      } as const);

/** A checkout directory; `config` is the text of its `.dw/config.yml`, or null for none. */
const checkout = (name: string, config: string | null): string => {
  const dir = tempDir(name);
  if (config !== null) {
    NodeFS.mkdirSync(NodePath.join(dir, ".dw"));
    NodeFS.writeFileSync(NodePath.join(dir, ".dw", "config.yml"), config);
  }
  return dir;
};

interface Fixture {
  /** Projects in creation order: id and workspace root. */
  readonly projects: ReadonlyArray<readonly [string, string]>;
  /** What the resolver answers per workspace root; a missing root answers null. */
  readonly identities: ReadonlyMap<string, RepositoryIdentity>;
  readonly scratch?: string;
  readonly deleted?: ReadonlyArray<string>;
}

const listed = (fixture: Fixture) => {
  const layerProjects = ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const layer = WatchedRepos.layer.pipe(
    Layer.provideMerge(layerProjects),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) => Effect.succeed(fixture.identities.get(cwd) ?? null),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/unused",
        scratchRoot: Effect.succeed(Option.fromUndefinedOr(fixture.scratch)),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    let sequence = 0;
    for (const [id, root] of fixture.projects) {
      yield* store.apply(projectEvent("project.created", id, root, (sequence += 1)));
    }
    for (const id of fixture.deleted ?? []) {
      yield* store.apply(projectEvent("project.deleted", id, "", (sequence += 1)));
    }
    const watched = yield* WatchedRepos.FactoryWatchedRepos;
    return yield* watched.list;
  }).pipe(Effect.provide(layer));
};

describe("FactoryWatchedRepos.list", () => {
  it.effect("lists a project whose checkout opts in, with its GitHub repo and title", () =>
    Effect.gen(function* () {
      const root = checkout("widgets", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [["p-widgets", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list, [
        { repo: "acme/widgets", path: root, title: "Title of p-widgets" },
      ]);
    }),
  );

  it.effect("skips a project with no repository identity", () =>
    Effect.gen(function* () {
      const root = checkout("no-identity", FACTORY_CONFIG);
      const list = yield* listed({ projects: [["p-none", root]], identities: new Map() });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("skips a project whose checkout has no .dw/config.yml", () =>
    Effect.gen(function* () {
      const root = checkout("no-config", null);
      const list = yield* listed({
        projects: [["p-bare", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("skips a project whose .dw/config.yml has no factory block", () =>
    Effect.gen(function* () {
      const root = checkout("no-block", "tracker:\n  backend: do-work-io\n");
      const list = yield* listed({
        projects: [["p-no-block", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("skips a project whose .dw/config.yml is not YAML", () =>
    Effect.gen(function* () {
      const root = checkout("broken", "factory: [unclosed\n");
      const list = yield* listed({
        projects: [["p-broken", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("skips the scratch project even when it holds a config and an identity", () =>
    Effect.gen(function* () {
      const scratch = checkout("scratch", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [["p-scratch", scratch]],
        identities: new Map([[scratch, WIDGETS]]),
        scratch,
      });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("skips a project whose repository is not on GitHub", () =>
    Effect.gen(function* () {
      const root = checkout("gitlab", FACTORY_CONFIG);
      const gitlab: RepositoryIdentity = {
        canonicalKey: "gitlab.com/acme/widgets",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://gitlab.com/acme/widgets.git",
        },
        provider: "gitlab",
        owner: "acme",
        name: "widgets",
      };
      const list = yield* listed({
        projects: [["p-gitlab", root]],
        identities: new Map([[root, gitlab]]),
      });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("skips a GitHub identity that lacks an owner or a name", () =>
    Effect.gen(function* () {
      const root = checkout("half", FACTORY_CONFIG);
      const { owner: _owner, ...noOwner } = WIDGETS;
      const list = yield* listed({
        projects: [["p-half", root]],
        identities: new Map([[root, noOwner]]),
      });
      assert.deepStrictEqual(list, []);
    }),
  );

  it.effect("lists two projects at different roots, in creation order", () =>
    Effect.gen(function* () {
      const first = checkout("first", FACTORY_CONFIG);
      const second = checkout("second", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [
          ["p-first", first],
          ["p-second", second],
        ],
        identities: new Map([
          [first, WIDGETS],
          [second, GADGETS],
        ]),
      });
      assert.deepStrictEqual(list, [
        { repo: "acme/widgets", path: first, title: "Title of p-first" },
        { repo: "acme/gadgets", path: second, title: "Title of p-second" },
      ]);
    }),
  );

  it.effect("leaves out a deleted project and keeps the rest", () =>
    Effect.gen(function* () {
      const gone = checkout("gone", FACTORY_CONFIG);
      const kept = checkout("kept", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [
          ["p-gone", gone],
          ["p-kept", kept],
        ],
        identities: new Map([
          [gone, WIDGETS],
          [kept, GADGETS],
        ]),
        deleted: ["p-gone"],
      });
      assert.deepStrictEqual(list, [
        { repo: "acme/gadgets", path: kept, title: "Title of p-kept" },
      ]);
    }),
  );

  it.effect("does not ask for the identity of a checkout that did not opt in", () =>
    Effect.gen(function* () {
      const root = checkout("unopted", null);
      const asked: Array<string> = [];
      const layer = WatchedRepos.layer.pipe(
        Layer.provideMerge(ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
        Layer.provide(
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: (cwd) => Effect.sync(() => void asked.push(cwd)).pipe(Effect.as(WIDGETS)),
          }),
        ),
        Layer.provide(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/unused",
            scratchRoot: Effect.succeedNone,
          }),
        ),
        Layer.provide(NodeServices.layer),
      );
      const list = yield* Effect.gen(function* () {
        const store = yield* ProjectStore.ProjectStoreV2;
        yield* store.apply(projectEvent("project.created", "p-unopted", root, 1));
        const watched = yield* WatchedRepos.FactoryWatchedRepos;
        return yield* watched.list;
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(list, []);
      assert.deepStrictEqual(asked, []);
    }),
  );
});
