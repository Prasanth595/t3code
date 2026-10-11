import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverFxSkills } from "./skills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverFxSkills", (it) => {
  it.effect("lists workspace skills before user skills, using the header name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* writeSkill(
        path.join(workspace, ".fx", "skills"),
        "review",
        ["---", "name: review", "description: Review the diff.", "---", "", "# Review"].join("\n"),
      );
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "directory-name",
        ["---", "name: header-name", "description: Named in YAML.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills).toEqual([
        {
          name: "review",
          path: path.join(workspace, ".fx", "skills", "review", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Review the diff.",
        },
        {
          name: "header-name",
          path: path.join(home, ".fx", "skills", "directory-name", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Named in YAML.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops the upward walk before HOME and keeps the nearer copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      const nested = path.join(workspace, "nested");
      yield* writeSkill(
        path.join(home, "skills"),
        "home-workspace-skill",
        ["---", "name: home-workspace-skill", "description: Should not load.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".fx", "skills"),
        "shared",
        ["---", "name: shared", "description: Parent copy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(nested, ".fx", "skills"),
        "shared",
        ["---", "name: shared", "description: Nested copy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(nested, "skills"),
        "local",
        ["---", "name: local", "description: Plain skills root.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: nested,
        environment: { HOME: home },
      });

      expect(skills).toEqual([
        {
          name: "shared",
          path: path.join(nested, ".fx", "skills", "shared", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Nested copy.",
        },
        {
          name: "local",
          path: path.join(nested, "skills", "local", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Plain skills root.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the directory name when SKILL.md has no header, including a trailing space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      yield* writeSkill(path.join(home, ".fx", "skills"), "plain-skill", "# No frontmatter\n");
      yield* writeSkill(path.join(home, ".fx", "skills"), "spaced-skill ", "# No frontmatter\n");

      const skills = yield* discoverFxSkills({ environment: { HOME: home } });

      expect(
        skills.find((skill) => skill.path.endsWith(`${path.sep}plain-skill${path.sep}SKILL.md`)),
      ).toEqual({
        name: "plain-skill",
        path: path.join(home, ".fx", "skills", "plain-skill", "SKILL.md"),
        scope: "user",
        enabled: true,
      });
      expect(
        skills.find((skill) => skill.path.endsWith(`${path.sep}spaced-skill ${path.sep}SKILL.md`)),
      ).toEqual({
        name: "spaced-skill",
        path: path.join(home, ".fx", "skills", "spaced-skill ", "SKILL.md"),
        scope: "user",
        enabled: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reads user skills from HostProcess.HomeDirectory when HOME is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "fallback-home");
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "from-fallback",
        ["---", "name: from-fallback", "description: Home fallback.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: {},
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));

      expect(skills).toEqual([
        {
          name: "from-fallback",
          path: path.join(home, ".fx", "skills", "from-fallback", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Home fallback.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the workspace skill when a user skill has the same name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* writeSkill(
        path.join(workspace, ".fx", "skills"),
        "shared",
        ["---", "name: shared", "description: Workspace copy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "shared",
        ["---", "name: shared", "description: User copy.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills).toEqual([
        {
          name: "shared",
          path: path.join(workspace, ".fx", "skills", "shared", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Workspace copy.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "skips missing roots, stray files, a file named skills, and directories without SKILL.md",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
        const home = path.join(tempDir, "home");
        const workspace = path.join(home, "project");
        const skillsRoot = path.join(home, ".fx", "skills");
        yield* fs.makeDirectory(workspace, { recursive: true });
        yield* fs.writeFileString(path.join(workspace, "skills"), "not a directory");
        yield* fs.makeDirectory(skillsRoot, { recursive: true });
        yield* fs.writeFileString(path.join(skillsRoot, ".DS_Store"), "not a skill");
        yield* fs.writeFileString(path.join(skillsRoot, "README.md"), "# skills");
        yield* fs.makeDirectory(path.join(skillsRoot, "empty"), { recursive: true });
        yield* writeSkill(
          skillsRoot,
          "review",
          ["---", "name: review", "description: Review the diff.", "---"].join("\n"),
        );

        const skills = yield* discoverFxSkills({
          cwd: workspace,
          environment: { HOME: home },
        });

        expect(skills).toEqual([
          {
            name: "review",
            path: path.join(skillsRoot, "review", "SKILL.md"),
            scope: "user",
            enabled: true,
            description: "Review the diff.",
          },
        ]);
      }).pipe(Effect.scoped),
  );
});
