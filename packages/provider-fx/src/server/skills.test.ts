import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverFxSkills } from "./skills.ts";

describe("discoverFxSkills", () => {
  // fx 0.0.13 scans the workspace roots of each directory from the workspace
  // up to HOME, then ~/.fx/skills, then the home compatibility roots
  // (src/builtins/skills.zig). Its skill menu lists ~/.fx/skills first, then
  // workspace .fx/skills and skills/, then every compatibility root in scan
  // order (skillGroupRank in src/core/skills/skill_runtime.zig).
  it.effect("lists skills in fx's own order", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The workspace sits under the fake HOME, so the upward walk stops there.
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fx-skills-home-" });
      const parent = path.join(home, "projects");
      const workspace = path.join(parent, "app");
      const writeSkill = (root: string, name: string) =>
        fileSystem
          .makeDirectory(path.join(root, name), { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(
                path.join(root, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`,
              ),
            ),
          );
      yield* writeSkill(path.join(workspace, ".claude/skills"), "workspace-claude");
      yield* writeSkill(path.join(workspace, ".fx/skills"), "workspace-fx");
      yield* writeSkill(path.join(parent, ".agents/skills"), "parent-agents");
      yield* writeSkill(path.join(parent, "skills"), "parent-shared");
      yield* writeSkill(path.join(home, ".claude/skills"), "home-claude");
      yield* writeSkill(path.join(home, ".fx/skills"), "home-fx");
      // HOME is not a workspace ancestor, and ~/skills is no fx root.
      yield* writeSkill(path.join(home, "skills"), "home-shared");

      const skills = yield* discoverFxSkills({ cwd: workspace, environment: { HOME: home } });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        [
          "home-fx",
          "workspace-fx",
          "parent-shared",
          "workspace-claude",
          "parent-agents",
          "home-claude",
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // fx keeps both skills that share a name and refuses `$review` as
  // ambiguous; it skips a SKILL.md whose frontmatter has no name.
  it.effect("offers only skills fx can load and invoke by name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fx-skills-home-" });
      const workspace = path.join(home, "app");
      const writeSkillFile = (folder: string, contents: string) =>
        fileSystem
          .makeDirectory(folder, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(path.join(folder, "SKILL.md"), contents)),
          );
      yield* writeSkillFile(
        path.join(workspace, ".fx/skills/review"),
        "---\nname: review\n---\nBody.\n",
      );
      yield* writeSkillFile(path.join(home, ".claude/skills/review"), "---\nname: review\n---\n");
      yield* writeSkillFile(path.join(home, ".fx/skills/plain"), "No frontmatter.\n");
      yield* writeSkillFile(
        path.join(home, ".fx/skills/unnamed"),
        "---\ndescription: Missing name\n---\n",
      );

      const skills = yield* discoverFxSkills({ cwd: workspace, environment: { HOME: home } });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.userInvocable !== false]),
        [
          ["plain", true],
          ["review", false],
          ["review", false],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
