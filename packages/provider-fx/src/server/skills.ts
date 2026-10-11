/**
 * Discover fx skills for the `$` picker by scanning SKILL.md directories.
 *
 * Roots are an ordered table in fx's documented order. Workspace roots are
 * repeated from the workspace upward, stopping before the home directory, then
 * the user roots. The first skill with a name wins.
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

type SkillScope = "project" | "user";

interface SkillRoot {
  readonly scope: SkillScope;
  readonly relative: string;
}

const FX_SKILL_ROOTS = [
  { scope: "project", relative: ".fx/skills" },
  { scope: "project", relative: "skills" },
  { scope: "project", relative: ".opencode/skills" },
  { scope: "project", relative: ".codex/skills" },
  { scope: "project", relative: ".claude/skills" },
  { scope: "project", relative: ".agents/skills" },
  { scope: "project", relative: ".claw/skills" },
  { scope: "user", relative: ".fx/skills" },
  { scope: "user", relative: ".config/opencode/skills" },
  { scope: "user", relative: ".codex/skills" },
  { scope: "user", relative: ".claude/skills" },
  { scope: "user", relative: ".agents/skills" },
  { scope: "user", relative: ".claw/skills" },
] as const satisfies ReadonlyArray<SkillRoot>;

interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};
  try {
    const parsed = parseYamlDocument(match[1] ?? "");
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

function ancestorsBeforeHome(
  path: Path.Path,
  workspaceCwd: string,
  home: string,
): ReadonlyArray<string> {
  const homePath = path.resolve(home);
  const ancestors: Array<string> = [];
  let current = path.resolve(workspaceCwd);
  while (current !== homePath) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function concreteSkillRoots(
  path: Path.Path,
  home: string,
  workspaceCwd: string | undefined,
): ReadonlyArray<{ readonly directory: string; readonly scope: SkillScope }> {
  const projectRoots = FX_SKILL_ROOTS.filter((root) => root.scope === "project");
  const userRoots = FX_SKILL_ROOTS.filter((root) => root.scope === "user");
  const ancestors = workspaceCwd === undefined ? [] : ancestorsBeforeHome(path, workspaceCwd, home);
  return [
    ...ancestors.flatMap((ancestor) =>
      projectRoots.map((root) => ({
        directory: path.join(ancestor, root.relative),
        scope: "project" as const,
      })),
    ),
    ...userRoots.map((root) => ({
      directory: path.join(path.resolve(home), root.relative),
      scope: "user" as const,
    })),
  ];
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
  readonly scope: SkillScope;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootInfo = yield* skipUnreadable(input.directory, fileSystem.stat(input.directory));
  if (rootInfo?.type !== "Directory") return [];
  const entries = yield* skipUnreadable(input.directory, fileSystem.readDirectory(input.directory));
  if (entries === undefined) return [];

  const skills: Array<ServerProviderSkill> = [];
  for (const entry of entries) {
    const candidate = path.join(input.directory, entry);
    const candidateInfo = yield* skipUnreadable(candidate, fileSystem.stat(candidate));
    if (candidateInfo?.type !== "Directory") continue;
    const skillPath = path.join(candidate, "SKILL.md");
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

function firstNameWins(
  groups: ReadonlyArray<ReadonlyArray<ServerProviderSkill>>,
): ReadonlyArray<ServerProviderSkill> {
  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const skill of groups.flat()) {
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
  }
  return [...skillsByName.values()];
}

export const discoverFxSkills = Effect.fn("discoverFxSkills")(function* (input: {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const environment = input.environment ?? process.env;
  const home = environment.HOME?.trim() || (yield* HostProcess.HomeDirectory);
  const roots = concreteSkillRoots(path, home, input.cwd);
  const groups: Array<ReadonlyArray<ServerProviderSkill>> = [];
  for (const root of roots) {
    groups.push(yield* discoverSkillsInRoot(root));
  }
  return firstNameWins(groups);
});
