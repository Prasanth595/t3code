import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const BUNDLED_SKILL_METADATA = [
  {
    id: "t3code-threads",
    title: "Threads & worktrees",
    description: "Create threads, send follow-ups, and hand off work in managed worktrees.",
  },
  {
    id: "t3code-orchestration",
    title: "Orchestration",
    description: "Coordinate background agents, parallel tasks, reviews, and their results.",
  },
] as const;

export type BundledSkillSource = (typeof BUNDLED_SKILL_METADATA)[number] & {
  readonly files: Readonly<Record<string, string>>;
};

declare const __T3CODE_BUNDLED_SKILLS__: ReadonlyArray<BundledSkillSource> | undefined;

export const loadBundledSkillSources = Effect.fn("loadBundledSkillSources")(function* () {
  if (typeof __T3CODE_BUNDLED_SKILLS__ !== "undefined") return __T3CODE_BUNDLED_SKILLS__;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(BUNDLED_SKILL_METADATA, (skill) =>
    Effect.gen(function* () {
      const root = path.resolve(import.meta.dirname, "../../../../.agents/skills", skill.id);
      const entries = yield* Effect.forEach(["SKILL.md", "LICENSE"], (name) =>
        fs.readFileString(path.join(root, name)).pipe(Effect.map((text) => [name, text] as const)),
      );
      return { ...skill, files: Object.fromEntries(entries) };
    }),
  );
});
