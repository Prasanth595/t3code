import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  assertCodexSkillOverridesUnchanged,
  resolveCodexSkillOverrides,
} from "./CodexSkillOverrides.ts";

it.layer(NodeServices.layer)("Codex session skill overrides", (it) => {
  it.effect(
    "isolates concurrent configurations, resolves aliases, and preserves other defaults",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-overrides-" });
        const skill = path.join(root, "SKILL.md");
        const alias = path.join(root, "alias.md");
        const other = path.join(root, "other.md");
        const hardlink = path.join(root, "hardlink.md");
        yield* fs.writeFileString(skill, "sentinel");
        yield* fs.symlink(skill, alias);
        yield* fs.link(skill, hardlink);
        yield* fs.writeFileString(other, "other");
        const skills = [
          { name: "review", path: skill, enabled: true },
          { name: "review-alias", path: alias, enabled: true },
          { name: "review-hardlink", path: hardlink, enabled: true },
          { name: "other", path: other, enabled: false },
        ];
        const base = [{ path: other, enabled: false }];
        const resolve = (enabled: boolean) =>
          resolveCodexSkillOverrides({
            overrides: [{ path: alias, enabled }],
            skills,
            baseConfig: { config: base },
            userAgent: "codex_cli_rs/0.165.0",
          });
        const [baseline, treatment] = yield* Effect.all([resolve(false), resolve(true)], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual(
          baseline.skills.map((entry) => entry.enabled),
          [false, false, false, false],
        );
        assert.deepStrictEqual(
          treatment.skills.map((entry) => entry.enabled),
          [true, true, true, false],
        );
        assert.deepStrictEqual(base, [{ path: other, enabled: false }]);
        assert.deepStrictEqual(
          skills.map((entry) => entry.enabled),
          [true, true, true, false],
        );
        assert.deepStrictEqual(baseline.config[0], base[0]);
        assert.strictEqual(yield* fs.readFileString(skill), "sentinel");
        assert.strictEqual(yield* fs.readFileString(alias), "sentinel");
        for (const [overrides, reason] of [
          [
            [
              { path: skill, enabled: true },
              { path: alias, enabled: false },
            ],
            "conflicting-aliases",
          ],
          [[{ path: other, enabled: true }], "globally-disabled"],
          [[{ path: "relative/SKILL.md", enabled: false }], "relative-path"],
        ] as const) {
          const error = yield* resolveCodexSkillOverrides({
            overrides,
            skills,
            baseConfig: { config: base },
            userAgent: "codex_cli_rs/0.165.0",
          }).pipe(Effect.flip);
          assert.propertyVal(error, "reason", reason);
        }
        const oldRuntime = yield* resolveCodexSkillOverrides({
          overrides: [],
          skills,
          baseConfig: {},
          userAgent: "codex_cli_rs/0.164.0",
        }).pipe(Effect.flip);
        assert.propertyVal(oldRuntime, "reason", "unsupported-version");
        yield* assertCodexSkillOverridesUnchanged(
          [{ path: skill, enabled: false }],
          [{ path: skill, enabled: false }],
        );
        const changed = yield* assertCodexSkillOverridesUnchanged(undefined, [
          { path: skill, enabled: false },
        ]).pipe(Effect.flip);
        assert.propertyVal(changed, "reason", "session-policy-changed");
      }),
  );
});
