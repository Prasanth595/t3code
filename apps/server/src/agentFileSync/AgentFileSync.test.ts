import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type AgentFileSyncBundle } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as AgentFileSync from "./AgentFileSync.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-sync-" });
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(target);
  const write = Effect.fn("fixture.write")(function* (root: string, at: string, contents: string) {
    yield* fs.makeDirectory(path.dirname(path.join(root, at)), { recursive: true });
    yield* fs.writeFileString(path.join(root, at), contents);
  });
  const sync = yield* AgentFileSync.AgentFileSync.pipe(
    Effect.provide(
      AgentFileSync.layer.pipe(
        Layer.provide(Config.layerTest(directory, path.join(directory, "state"))),
        Layer.provide(
          Layer.succeed(KnownWorkspaces.KnownWorkspaces, {
            assertContains: (cwd) =>
              cwd === source || cwd === target
                ? Effect.void
                : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
            contains: (cwd) => Effect.succeed(cwd === source || cwd === target),
          }),
        ),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, source),
  );
  const run = Effect.fn("fixture.sync")(function* (bundle: AgentFileSyncBundle) {
    const preview = yield* sync.preview({ cwd: target, bundle });
    return yield* sync.apply({ cwd: target, bundle, expected: preview });
  });
  return { fs, path, directory, source, target, write, sync, run };
});
const sectionBundle = (contents: string): AgentFileSyncBundle => [
  {
    kind: "instructions",
    path: "AGENTS.md",
    sections: [{ id: "Shared:0", title: "Shared", contents }],
  },
];

it.layer(NodeServices.layer)("agent file sync", (it) => {
  it.effect(
    "copies only selected sections, updates without duplicates and restores the exact original",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const local = "# Local\r\nKeep this machine’s settings.\r\n";
        yield* f.write(f.target, "AGENTS.md", local);
        const first = yield* f.run(sectionBundle("## Shared\nRun focused tests.\n"));
        expect(first.failures).toEqual([]);
        const once = yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"));
        expect(once).toContain(local);
        expect(once).toContain("## Shared\r\nRun focused tests.");
        expect((yield* f.run(sectionBundle("## Shared\nRun focused tests.\n"))).paths).toEqual([]);
        const second = yield* f.run(sectionBundle("## Shared\nRun updated tests.\n"));
        const twice = yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"));
        expect(twice.match(/## Shared/g)).toHaveLength(1);
        expect(twice).toContain("Run updated tests.");
        expect((yield* f.sync.undo({ undoId: second.undoId! })).failures).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(once);
        expect((yield* f.sync.undo({ undoId: first.undoId! })).failures).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(local);
      }),
  );
  it.effect(
    "ongoing sync preserves local instruction text and stops at edits inside managed sections",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const previous = sectionBundle("## Shared\nOriginal rule.");
        yield* f.run(previous);
        const file = f.path.join(f.target, "AGENTS.md");
        const initial = yield* f.fs.readFileString(file);
        yield* f.fs.writeFileString(file, "Local addition.\n" + initial);
        const bundle = sectionBundle("## Shared\nUpdated rule.");
        yield* f.sync.reconcile({ cwd: f.target, previous, bundle });
        const updated = yield* f.fs.readFileString(file);
        expect(updated).toContain("Local addition.");
        expect(updated).toContain("Updated rule.");
        yield* f.sync.reconcile({ cwd: f.target, previous, bundle });
        yield* f.fs.writeFileString(file, updated.replace("Updated rule.", "Local override."));
        expect(
          (yield* f.sync
            .reconcile({ cwd: f.target, previous: bundle, bundle: sectionBundle("Third rule.") })
            .pipe(Effect.flip)).reason,
        ).toBe("changed");
        expect(yield* f.fs.readFileString(file)).toContain("Local override.");
      }),
  );
  it.effect("ongoing sync refuses edited skills and creates no repeated undo receipts", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const previous: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: ".agents/skills/test",
          files: [
            { path: "SKILL.md", data: Buffer.from("Original").toString("base64"), mode: 0o600 },
          ],
        },
      ];
      yield* f.run(previous);
      const bundle: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: ".agents/skills/test",
          files: [
            { path: "SKILL.md", data: Buffer.from("Updated").toString("base64"), mode: 0o600 },
          ],
        },
      ];
      yield* f.sync.reconcile({ cwd: f.target, previous, bundle });
      expect(
        yield* f.fs.readDirectory(f.path.join(f.directory, "state", "userdata", "agent-file-sync")),
      ).toHaveLength(1);
      yield* f.write(f.target, ".agents/skills/test/SKILL.md", "Local edit");
      expect(
        (yield* f.sync
          .reconcile({ cwd: f.target, previous: bundle, bundle: previous })
          .pipe(Effect.flip)).reason,
      ).toBe("changed");
    }),
  );
  it.effect(
    "exports the selected sections and the complete selected skill, including binary and executable files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const skill = ".agents/skills/deploy";
        yield* f.write(
          f.source,
          "AGENTS.md",
          "# Project\n\n## Shared\nUse tests.\n\n## Local\nOnly here.\n",
        );
        yield* f.write(f.source, `${skill}/SKILL.md`, "---\nname: deploy\n---\nDeploy.");
        yield* f.write(f.source, `${skill}/scripts/deploy.sh`, "#!/bin/sh\nexit 0\n");
        yield* f.fs.chmod(f.path.join(f.source, skill, "scripts/deploy.sh"), 0o750);
        yield* f.fs.writeFile(
          f.path.join(f.source, skill, "image.bin"),
          new Uint8Array([0, 255, 17]),
        );
        const list = yield* f.sync.list({ cwd: f.source });
        expect(list.skills.map((entry) => entry.path)).toEqual([skill]);
        const bundle = yield* f.sync.export({
          cwd: f.source,
          skills: [skill],
          instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
        });
        expect(bundle.find((entry) => entry.kind === "instructions")?.sections).toEqual([
          expect.objectContaining({ title: "Shared", contents: "## Shared\nUse tests.\n\n" }),
        ]);
        yield* f.write(f.target, `${skill}/SKILL.md`, "old");
        yield* f.write(f.target, `${skill}/obsolete.txt`, "stale");
        const applied = yield* f.run(bundle);
        expect(applied.failures).toEqual([]);
        expect(Array.from(yield* f.fs.readFile(f.path.join(f.target, skill, "image.bin")))).toEqual(
          [0, 255, 17],
        );
        expect(
          (yield* f.fs.stat(f.path.join(f.target, skill, "scripts/deploy.sh"))).mode & 0o777,
        ).toBe(0o750);
        expect(yield* f.fs.exists(f.path.join(f.target, skill, "obsolete.txt"))).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).not.toContain(
          "Only here.",
        );
        yield* f.sync.undo({ undoId: applied.undoId! });
        expect(yield* f.fs.readFileString(f.path.join(f.target, skill, "SKILL.md"))).toBe("old");
        expect(yield* f.fs.exists(f.path.join(f.target, skill, "obsolete.txt"))).toBe(true);
        expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
      }),
  );
  it.effect("compares Windows skill permissions using its writable bit", () =>
    Effect.gen(function* () {
      const f = yield* fixture.pipe(Effect.provideService(HostProcess.Platform, "win32"));
      const bundle: AgentFileSyncBundle = [
        {
          kind: "skill",
          path: ".agents/skills/review",
          files: [
            { path: "SKILL.md", data: Buffer.from("Review").toString("base64"), mode: 0o750 },
          ],
        },
      ];
      yield* f.run(bundle);
      expect(
        (yield* f.fs.stat(f.path.join(f.target, ".agents/skills/review/SKILL.md"))).mode & 0o777,
      ).toBe(0o666);
      yield* f.sync.reconcile({ cwd: f.target, previous: bundle, bundle });
      expect((yield* f.sync.preview({ cwd: f.target, bundle }))[0]?.changed).toBe(false);
    }),
  );
  it.effect("refuses a stale preview before writing any selected item", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bundle = sectionBundle("Shared");
      const expected = yield* f.sync.preview({ cwd: f.target, bundle });
      yield* f.write(f.target, "AGENTS.md", "Changed after preview");
      expect(
        (yield* f.sync.apply({ cwd: f.target, bundle, expected }).pipe(Effect.flip)).reason,
      ).toBe("changed");
      expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(
        "Changed after preview",
      );
    }),
  );
  it.effect("undo refuses to discard edits made after a sync", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.run(sectionBundle("Shared"));
      yield* f.write(f.target, "AGENTS.md", "Edited after sync");
      const undone = yield* f.sync.undo({ undoId: result.undoId! });
      expect(undone.failures).toHaveLength(1);
      expect(yield* f.fs.readFileString(f.path.join(f.target, "AGENTS.md"))).toBe(
        "Edited after sync",
      );
    }),
  );
  it.effect(
    "rejects traversal, provider credentials, nested skill paths and reserved Windows names",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const at of [
          "../outside",
          ".codex/auth.json",
          ".agents/skills/../escape",
          ".agents/skills/CON",
          ".agents/skills/nested/skill",
        ]) {
          const bundle: AgentFileSyncBundle = [
            { kind: "skill", path: at, files: [{ path: "SKILL.md", data: "", mode: 0o600 }] },
          ];
          expect((yield* f.sync.preview({ cwd: f.target, bundle }).pipe(Effect.flip)).reason).toBe(
            "invalid-path",
          );
        }
        expect(
          (yield* f.sync
            .preview({ cwd: f.directory, bundle: sectionBundle("text") })
            .pipe(Effect.flip)).reason,
        ).toBe("io");
      }),
  );
  it.effect("reads a linked source skill but refuses linked destination directories", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(f.directory, "canonical/SKILL.md", "Shared skill");
      yield* f.fs.makeDirectory(f.path.join(f.source, ".agents/skills"), { recursive: true });
      yield* f.fs.symlink(
        f.path.join(f.directory, "canonical"),
        f.path.join(f.source, ".agents/skills/shared"),
      );
      const bundle = yield* f.sync.export({
        cwd: f.source,
        skills: [".agents/skills/shared"],
        instructions: [],
      });
      yield* f.fs.makeDirectory(f.path.join(f.target, ".agents"));
      yield* f.fs.symlink(
        f.path.join(f.source, ".agents/skills"),
        f.path.join(f.target, ".agents/skills"),
      );
      expect((yield* f.sync.preview({ cwd: f.target, bundle }).pipe(Effect.flip)).reason).toBe(
        "linked-destination",
      );
      expect(yield* f.fs.readFileString(f.path.join(f.directory, "canonical/SKILL.md"))).toBe(
        "Shared skill",
      );
    }),
  );
  it.effect("rejects an incompatible destination before writing any other selected item", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bundle: AgentFileSyncBundle = [
        ...sectionBundle("Shared"),
        {
          kind: "instructions",
          path: "CLAUDE.md",
          sections: [{ id: "Rules:0", title: "Rules", contents: "Rules" }],
        },
      ];
      const expected = yield* f.sync.preview({ cwd: f.target, bundle });
      yield* f.fs.makeDirectory(f.path.join(f.target, "CLAUDE.md"));
      const rejected = yield* f.sync.apply({ cwd: f.target, bundle, expected }).pipe(Effect.flip);
      expect(rejected.reason).toBe("linked-destination");
      expect(yield* f.fs.exists(f.path.join(f.target, "AGENTS.md"))).toBe(false);
    }),
  );
  it.effect("enforces file bounds before reading or writing oversized files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(f.source, ".agents/skills/large/SKILL.md", "x".repeat(1024 * 1024 + 1));
      expect(
        (yield* f.sync
          .export({ cwd: f.source, skills: [".agents/skills/large"], instructions: [] })
          .pipe(Effect.flip)).reason,
      ).toBe("limit");
    }),
  );
  it.effect("personal sync uses the environment's home and never scans provider credentials", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(f.source, ".codex/AGENTS.md", "Personal rules");
      yield* f.write(f.source, ".codex/auth.json", "private");
      const catalog = yield* f.sync.list({});
      expect(catalog.instructions.map((file) => file.path)).toEqual([".codex/AGENTS.md"]);
      expect(catalog.instructions[0]?.sections[0]?.contents).toBe("Personal rules");
    }),
  );
});
