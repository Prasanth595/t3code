import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PROVIDER_INSTRUCTIONS_MAX_BYTES,
  ProjectId,
  ProviderInstanceId,
  type ProviderInstructionsFileName,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstructions from "./ProviderInstructions.ts";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");
const CURSOR = ProviderInstanceId.make("cursor");
const PROJECT = ProjectId.make("project-1");

const instanceWith = (instructions: ProviderInstance["instructions"]) =>
  ({ instructions }) as ProviderInstance;

const makeService = Effect.fn("makeService")(function* (input: {
  readonly workspaceRoot: string;
  readonly globalDirectory: string;
}) {
  const instances = new Map<string, ProviderInstance>([
    [CODEX, instanceWith({ fileName: "AGENTS.md", globalDirectory: input.globalDirectory })],
    [CLAUDE, instanceWith({ fileName: "CLAUDE.md", globalDirectory: input.globalDirectory })],
    [CURSOR, instanceWith(undefined)],
  ]);
  const layer = ProviderInstructions.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) => Effect.succeed(instances.get(instanceId)),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (projectId) =>
          Effect.succeed(
            projectId === PROJECT
              ? Option.some({ workspaceRoot: input.workspaceRoot } as ProjectStore.ProjectRow)
              : Option.none(),
          ),
      }),
    ),
  );
  return yield* Effect.service(ProviderInstructions.ProviderInstructions).pipe(
    Effect.provide(layer.pipe(Layer.provide(NodeServices.layer))),
  );
});

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-instructions-" });
  const workspaceRoot = path.join(root, "workspace");
  const globalDirectory = path.join(root, "home", ".tool");
  yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
  const service = yield* makeService({ workspaceRoot, globalDirectory });
  return { fileSystem, path, root, workspaceRoot, globalDirectory, service };
});

const failureOf = <A, E extends { readonly failure?: string; readonly _tag: string }>(
  exit: Exit.Exit<A, E>,
) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  return error?._tag === "ProviderInstructionsError" ? error.failure : error?._tag;
};

it.layer(NodeServices.layer, { excludeTestServices: true })("ProviderInstructions", (it) => {
  it.effect("creates a missing user-level file, then edits it with the returned revision", () =>
    Effect.gen(function* () {
      const { service, fileSystem, path, globalDirectory } = yield* makeFixture;
      const missing = yield* service.read({ instanceId: CODEX });
      expect(missing).toMatchObject({
        fileName: "AGENTS.md",
        path: path.join(globalDirectory, "AGENTS.md"),
        contents: "",
        state: "missing",
      });

      const created = yield* service.write({
        instanceId: CODEX,
        contents: "Be brief.\r\n",
        revision: missing.revision,
      });
      expect(yield* fileSystem.readFileString(path.join(globalDirectory, "AGENTS.md"))).toBe(
        "Be brief.\r\n",
      );

      const opened = yield* service.read({ instanceId: CODEX });
      expect(opened).toMatchObject({ contents: "Be brief.\r\n", state: "ready" });
      expect(opened.revision).toBe(created.revision);

      yield* service.write({
        instanceId: CODEX,
        contents: "Be thorough.\n",
        revision: opened.revision,
      });
      expect((yield* service.read({ instanceId: CODEX })).contents).toBe("Be thorough.\n");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to overwrite a file that changed after it was read", () =>
    Effect.gen(function* () {
      const { service, fileSystem, path, workspaceRoot } = yield* makeFixture;
      const file = path.join(workspaceRoot, "AGENTS.md");
      yield* fileSystem.writeFileString(file, "first");
      const opened = yield* service.read({ instanceId: CODEX, projectId: PROJECT });

      yield* fileSystem.writeFileString(file, "changed by an agent");
      const stale = yield* Effect.exit(
        service.write({
          instanceId: CODEX,
          projectId: PROJECT,
          contents: "mine",
          revision: opened.revision,
        }),
      );
      expect(failureOf(stale)).toBe("ProviderInstructionsConflictError");
      expect(yield* fileSystem.readFileString(file)).toBe("changed by an agent");

      const racingCreate = yield* Effect.exit(
        service.write({
          instanceId: CODEX,
          projectId: PROJECT,
          contents: "mine",
          revision: "missing",
        }),
      );
      expect(failureOf(racingCreate)).toBe("ProviderInstructionsConflictError");
    }).pipe(Effect.scoped),
  );

  it.effect("lets only one of two saves from the same revision through", () =>
    Effect.gen(function* () {
      const { service, fileSystem, path, workspaceRoot } = yield* makeFixture;
      const file = path.join(workspaceRoot, "AGENTS.md");
      yield* fileSystem.writeFileString(file, "base");
      const opened = yield* service.read({ instanceId: CODEX, projectId: PROJECT });
      const save = (contents: string) =>
        Effect.exit(
          service.write({
            instanceId: CODEX,
            projectId: PROJECT,
            contents,
            revision: opened.revision,
          }),
        );

      const exits = yield* Effect.all([save("first"), save("other")], {
        concurrency: "unbounded",
      });

      expect(
        exits.map((exit) => (Exit.isSuccess(exit) ? "saved" : failureOf(exit))).sort(),
      ).toEqual(["ProviderInstructionsConflictError", "saved"]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps an edited file's permissions",
    () =>
      Effect.gen(function* () {
        const { service, fileSystem, path, workspaceRoot } = yield* makeFixture;
        const file = path.join(workspaceRoot, "AGENTS.md");
        yield* fileSystem.writeFileString(file, "base");
        yield* fileSystem.chmod(file, 0o640);
        const opened = yield* service.read({ instanceId: CODEX, projectId: PROJECT });

        yield* service.write({
          instanceId: CODEX,
          projectId: PROJECT,
          contents: "edited",
          revision: opened.revision,
        });

        expect(((yield* fileSystem.stat(file)).mode & 0o777).toString(8)).toBe("640");
      }).pipe(Effect.scoped),
  );

  it.effect("rejects a revision that was read from a different file", () =>
    Effect.gen(function* () {
      const { service, fileSystem, path, globalDirectory } = yield* makeFixture;
      const projectRead = yield* service.read({ instanceId: CODEX, projectId: PROJECT });

      const exit = yield* Effect.exit(
        service.write({ instanceId: CODEX, contents: "x", revision: projectRead.revision }),
      );

      expect(failureOf(exit)).toBe("ProviderInstructionsConflictError");
      expect(yield* fileSystem.exists(path.join(globalDirectory, "AGENTS.md"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a missing CLAUDE.md as an import so an existing AGENTS.md keeps applying", () =>
    Effect.gen(function* () {
      const { service, fileSystem, path, workspaceRoot } = yield* makeFixture;
      const without = yield* service.read({ instanceId: CLAUDE, projectId: PROJECT });
      expect(without).toMatchObject({ fileName: "CLAUDE.md", contents: "", state: "missing" });

      yield* fileSystem.writeFileString(path.join(workspaceRoot, "AGENTS.md"), "Shared rules");
      const withAgents = yield* service.read({ instanceId: CLAUDE, projectId: PROJECT });
      expect(withAgents).toMatchObject({ contents: "@AGENTS.md\n", state: "missing" });
      const codex = yield* service.read({ instanceId: CODEX, projectId: PROJECT });
      expect(codex).toMatchObject({ contents: "Shared rules", state: "ready" });
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "writes through a symlinked file instead of replacing the link",
    () =>
      Effect.gen(function* () {
        const { service, fileSystem, path, workspaceRoot } = yield* makeFixture;
        yield* fileSystem.writeFileString(path.join(workspaceRoot, "AGENTS.md"), "one");
        yield* fileSystem.symlink("AGENTS.md", path.join(workspaceRoot, "CLAUDE.md"));

        const opened = yield* service.read({ instanceId: CLAUDE, projectId: PROJECT });
        expect(opened.contents).toBe("one");
        yield* service.write({
          instanceId: CLAUDE,
          projectId: PROJECT,
          contents: "two",
          revision: opened.revision,
        });

        expect(yield* fileSystem.readFileString(path.join(workspaceRoot, "AGENTS.md"))).toBe("two");
        expect((yield* fileSystem.readLink(path.join(workspaceRoot, "CLAUDE.md"))).toString()).toBe(
          "AGENTS.md",
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses a project file that links outside the project",
    () =>
      Effect.gen(function* () {
        const { service, fileSystem, path, root, workspaceRoot } = yield* makeFixture;
        const outside = path.join(root, "outside.md");
        yield* fileSystem.writeFileString(outside, "secret");
        yield* fileSystem.symlink(outside, path.join(workspaceRoot, "AGENTS.md"));
        yield* fileSystem.symlink(
          path.join(root, "nowhere.md"),
          path.join(workspaceRoot, "CLAUDE.md"),
        );

        expect(
          failureOf(yield* Effect.exit(service.read({ instanceId: CODEX, projectId: PROJECT }))),
        ).toBe("outside_workspace");
        expect(
          failureOf(
            yield* Effect.exit(
              service.write({
                instanceId: CODEX,
                projectId: PROJECT,
                contents: "x",
                revision: "missing",
              }),
            ),
          ),
        ).toBe("outside_workspace");
        expect(
          failureOf(yield* Effect.exit(service.read({ instanceId: CLAUDE, projectId: PROJECT }))),
        ).toBe("not_file");
        expect(yield* fileSystem.readFileString(outside)).toBe("secret");
      }).pipe(Effect.scoped),
  );

  it.effect("reports files it cannot edit without returning their bytes", () =>
    Effect.gen(function* () {
      const { service, fileSystem, path, workspaceRoot } = yield* makeFixture;
      const file = path.join(workspaceRoot, "AGENTS.md");

      yield* fileSystem.writeFile(file, new Uint8Array([104, 105, 0, 1]));
      expect(yield* service.read({ instanceId: CODEX, projectId: PROJECT })).toMatchObject({
        state: "binary",
        contents: "",
      });

      yield* fileSystem.writeFile(file, new Uint8Array([99, 97, 102, 0xe9]));
      const latin1 = yield* service.read({ instanceId: CODEX, projectId: PROJECT });
      expect(latin1).toMatchObject({ state: "binary", contents: "" });
      expect(
        failureOf(
          yield* Effect.exit(
            service.write({
              instanceId: CODEX,
              projectId: PROJECT,
              contents: "a\u0000b",
              revision: latin1.revision,
            }),
          ),
        ),
      ).toBe("binary");

      yield* fileSystem.writeFileString(file, "x".repeat(PROVIDER_INSTRUCTIONS_MAX_BYTES + 1));
      expect(yield* service.read({ instanceId: CODEX, projectId: PROJECT })).toMatchObject({
        state: "too_large",
        contents: "",
      });

      expect(
        failureOf(
          yield* Effect.exit(
            service.write({
              instanceId: CODEX,
              projectId: PROJECT,
              contents: "x".repeat(PROVIDER_INSTRUCTIONS_MAX_BYTES + 1),
              revision: "missing",
            }),
          ),
        ),
      ).toBe("too_large");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects targets the provider or project cannot have", () =>
    Effect.gen(function* () {
      const { service } = yield* makeFixture;
      const read = (input: Parameters<typeof service.read>[0]) =>
        Effect.exit(service.read(input)).pipe(Effect.map(failureOf));

      expect(yield* read({ instanceId: CURSOR })).toBe("global_unsupported");
      expect(yield* read({ instanceId: ProviderInstanceId.make("missing") })).toBe(
        "provider_not_found",
      );
      expect(yield* read({ instanceId: CODEX, projectId: ProjectId.make("other") })).toBe(
        "project_not_found",
      );
      // A provider without a declaration still reads AGENTS.md in a project.
      expect(yield* service.read({ instanceId: CURSOR, projectId: PROJECT })).toMatchObject({
        fileName: "AGENTS.md" satisfies ProviderInstructionsFileName,
        state: "missing",
      });
    }).pipe(Effect.scoped),
  );
});
