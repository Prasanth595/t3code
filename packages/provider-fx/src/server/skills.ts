/**
 * Discovers fx skills for the `$` picker by scanning the SKILL.md folders fx
 * reads (fx 0.0.13, src/builtins/skills.zig), so no `fx acp` session starts
 * for a composer menu.
 *
 * @module provider-fx/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 1_000_000;

/**
 * fx's menu lists its managed `~/.fx/skills` first, then a workspace's own
 * `.fx/skills` and `skills/`, then every compatibility root
 * (`skillGroupRank` in src/core/skills/skill_runtime.zig).
 */
type SkillRoot = { readonly relative: string; readonly rank: 0 | 1 | 2 };

const FX_WORKSPACE_ROOTS: ReadonlyArray<SkillRoot> = [
  { relative: ".fx/skills", rank: 1 },
  { relative: "skills", rank: 1 },
  { relative: ".opencode/skills", rank: 2 },
  { relative: ".codex/skills", rank: 2 },
  { relative: ".claude/skills", rank: 2 },
  { relative: ".agents/skills", rank: 2 },
  { relative: ".claw/skills", rank: 2 },
];
const FX_HOME_ROOTS: ReadonlyArray<SkillRoot> = [
  { relative: ".fx/skills", rank: 0 },
  { relative: ".config/opencode/skills", rank: 2 },
  { relative: ".codex/skills", rank: 2 },
  { relative: ".claude/skills", rank: 2 },
  { relative: ".agents/skills", rank: 2 },
  { relative: ".claw/skills", rank: 2 },
];

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSkillFrontmatter(contents: string): {
  readonly name?: string;
  readonly description?: string;
} {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const name = nonEmptyTrimmed(record.name);
    const description = nonEmptyTrimmed(record.description);
    return {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
    };
  } catch {
    return {};
  }
}

/**
 * fx scans the workspace roots of each directory from the workspace up to,
 * not including, HOME, then its managed root, then the home roots.
 */
function skillRoots(path: Path.Path, cwd: string, home: string) {
  const roots: Array<{
    readonly directory: string;
    readonly scope: string;
    readonly rank: number;
  }> = [];
  for (let current = path.resolve(cwd); current !== home;) {
    for (const root of FX_WORKSPACE_ROOTS) {
      roots.push({
        directory: path.join(current, root.relative),
        scope: "project",
        rank: root.rank,
      });
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of FX_HOME_ROOTS) {
    roots.push({ directory: path.join(home, root.relative), scope: "user", rank: root.rank });
  }
  return roots;
}

const skipUnreadable = <A, R>(
  path: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.void.pipe(Effect.as(undefined))
          : Effect.logWarning("fx skill scan skipped an unreadable path.", {
              path,
              errorTag: error.reason._tag,
            }).pipe(Effect.as(undefined)),
    }),
  );

const discoverSkillsInRoot = Effect.fn("discoverFxSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: string;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* skipUnreadable(input.directory, fileSystem.readDirectory(input.directory));
  const skills: Array<ServerProviderSkill> = [];
  for (const entry of entries ?? []) {
    const skillPath = path.join(input.directory, entry, "SKILL.md");
    const skillInfo = yield* skipUnreadable(skillPath, fileSystem.stat(skillPath));
    if (skillInfo?.type !== "File") continue;
    if (skillInfo.size > MAX_SKILL_BYTES) {
      yield* Effect.logWarning("fx skill scan skipped an oversized SKILL.md.", {
        path: skillPath,
        bytes: skillInfo.size,
      });
      continue;
    }
    const contents = yield* skipUnreadable(skillPath, fileSystem.readFileString(skillPath));
    if (contents === undefined) continue;
    const frontmatter = parseSkillFrontmatter(contents);
    const name = frontmatter.name ?? nonEmptyTrimmed(entry);
    if (name === undefined) continue;
    skills.push({
      name,
      path: skillPath,
      scope: input.scope,
      enabled: true,
      ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
    });
  }
  return skills;
});

/** Skills in fx's menu order. The first root to name a skill wins, as in fx. */
export const discoverFxSkills = Effect.fn("discoverFxSkills")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = path.resolve(input.environment.HOME?.trim() || (yield* HostProcess.HomeDirectory));
  const ranked = new Map<string, { readonly skill: ServerProviderSkill; readonly rank: number }>();
  for (const root of skillRoots(path, input.cwd, home)) {
    for (const skill of yield* discoverSkillsInRoot(root)) {
      if (!ranked.has(skill.name)) ranked.set(skill.name, { skill, rank: root.rank });
    }
  }
  return [...ranked.values()]
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.skill);
});
