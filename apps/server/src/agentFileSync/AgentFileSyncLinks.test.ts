import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type AgentFileSyncBundle } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as AgentFileSync from "./AgentFileSync.ts";
import * as AgentFileSyncLinks from "./AgentFileSyncLinks.ts";

const bundle = (text: string): AgentFileSyncBundle => [
  {
    kind: "instructions",
    path: "AGENTS.md",
    sections: [{ id: "Shared:0", title: "Shared", contents: `## Shared\n${text}\n` }],
  },
];
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-links-" });
  const config = Config.layerTest(directory, path.join(directory, "data"));
  const storage = new Map<string, Uint8Array>();
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(storage.get(name))),
      set: (name, data) =>
        Effect.sync(() => {
          storage.set(name, Uint8Array.from(data));
        }),
      create: () => Effect.void,
      remove: (name) =>
        Effect.sync(() => {
          storage.delete(name);
        }),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    }),
  );
  const fileLayer = AgentFileSync.layer.pipe(
    Layer.provide(config),
    Layer.provide(
      Layer.succeed(KnownWorkspaces.KnownWorkspaces, {
        assertContains: () => Effect.void,
        contains: () => Effect.succeed(true),
      }),
    ),
  );
  const files = yield* AgentFileSync.AgentFileSync.pipe(
    Effect.provide(fileLayer),
    Effect.provideService(HostProcess.HomeDirectory, directory),
  );
  const load = AgentFileSyncLinks.AgentFileSyncLinks.pipe(
    Effect.provide(AgentFileSyncLinks.layer.pipe(Layer.provide(secrets))),
    Effect.provideService(AgentFileSync.AgentFileSync, files),
    Effect.provideService(HostProcess.HomeDirectory, directory),
  );
  const links = yield* load;
  const subscribe = Effect.fn("fixture.subscribe")(function* () {
    yield* links.subscribe({
      sourceEnvironmentId: EnvironmentId.make("source"),
      selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
      label: "Source",
      bundle: bundle("Initial"),
      expected: yield* files.preview({ bundle: bundle("Initial") }),
    });
    return (yield* links.list)[0]!;
  });
  return { fs, path, directory, files, links, load, subscribe };
});

it.layer(NodeServices.layer)("sync subscriptions", (it) => {
  it.effect("survives restarts and never exposes baseline file contents in its catalog", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      expect(link).not.toHaveProperty("previous");
      expect(yield* (yield* f.load).list).toEqual([link]);
      expect(
        (yield* f.files
          .check({
            selection: {
              cwd: f.directory,
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            revision: link.revision,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("changed");
    }),
  );
  it.effect("serializes multiple clients and ignores stale generations", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      yield* f.links.refresh({ id: link.id, generation: 0, bundle: bundle("New") });
      yield* f.links.refresh({ id: link.id, generation: 0, bundle: bundle("Stale") });
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain("New");
      const current = (yield* f.links.list)[0]!;
      expect(current.generation).toBe(1);
      yield* f.links.refresh({ id: link.id, generation: 1, bundle: null });
      expect((yield* f.links.list)[0]!.generation).toBe(1);
    }),
  );
  it.effect("pauses at a conflict, resumes after repair, and removes without deleting files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = yield* f.subscribe();
      const file = f.path.join(f.directory, "AGENTS.md");
      const original = yield* f.fs.readFileString(file);
      yield* f.fs.writeFileString(file, original.replace("Initial", "Local edit"));
      expect(
        (yield* f.links.refresh({ id: link.id, generation: 0, bundle: null }).pipe(Effect.flip))
          .reason,
      ).toBe("changed");
      const paused = (yield* f.links.list)[0]!;
      expect(paused.paused).toBe(true);
      expect(paused.error).toContain("Files changed");
      yield* f.links.refresh({
        id: link.id,
        generation: paused.generation,
        bundle: bundle("Ignored while paused"),
      });
      expect(yield* f.fs.readFileString(file)).toContain("Local edit");
      yield* f.fs.writeFileString(file, original);
      yield* f.links.manage({ id: link.id, action: "resume" });
      const resumed = (yield* f.links.list)[0]!;
      yield* f.links.refresh({
        id: link.id,
        generation: resumed.generation,
        bundle: bundle("Resumed"),
      });
      expect(yield* f.fs.readFileString(file)).toContain("Resumed");
      yield* f.links.manage({ id: link.id, action: "remove" });
      expect(yield* f.links.list).toEqual([]);
      expect(yield* f.fs.readFileString(file)).toContain("Resumed");
    }),
  );
  it.effect("rechecks write permission after waiting for the file lock", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* f.files
        .apply(
          { bundle: [], expected: [] },
          false,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      let allowed = true;
      const input = {
        sourceEnvironmentId: EnvironmentId.make("source"),
        selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
        label: "Source",
        bundle: bundle("Denied"),
        expected: yield* f.files.preview({ bundle: bundle("Denied") }),
      };
      const request = yield* Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(
          f.links.subscribe(
            input,
            Effect.suspend(() =>
              allowed ? Effect.void : Effect.fail("permission-revoked" as const),
            ),
          ),
        ),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(queued);
      allowed = false;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(request)).toMatchObject({
        _tag: "Failure",
        failure: "permission-revoked",
      });
      expect(yield* f.links.list).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(f.directory, "AGENTS.md"))).toBe(false);
    }),
  );
  it.effect(
    "recognizes destination aliases and personal/project scopes sharing the same files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.subscribe();
        const rejected = yield* f.links
          .subscribe({
            cwd: `${f.directory}/.`,
            sourceEnvironmentId: EnvironmentId.make("another-source"),
            selection: {
              skills: [],
              instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
            },
            label: "Other",
            bundle: bundle("Overwrite"),
            expected: yield* f.files.preview({ bundle: bundle("Overwrite") }),
          })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("overlap");
        expect(yield* f.fs.readFileString(f.path.join(f.directory, "AGENTS.md"))).toContain(
          "Initial",
        );
      }),
  );
  it.effect("rejects overlapping subscriptions before changing files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.subscribe();
      expect((yield* f.subscribe().pipe(Effect.flip)).reason).toBe("overlap");
      expect(yield* f.links.list).toHaveLength(1);
    }),
  );
});
