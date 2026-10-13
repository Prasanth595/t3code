/**
 * Discovers fx skills for the `$` picker by scanning the SKILL.md folders fx
 * reads (fx 0.0.13, src/builtins/skills.zig), so no `fx acp` session starts
 * for a composer menu.
 *
 * @module provider-fx/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 1_000_000;

/**
 * fx's menu lists its managed `~/.fx/skills` first, then a workspace's own
 * `.fx/skills` and `skills/`, then every compatibility root
 * (`skillGroupRank` in src/core/skills/skill_runtime.zig). fx follows a
 * symlinked skill folder in every root except its managed one, which it
 * fills itself.
 */
type SkillRoot = {
  readonly relative: string;
  readonly rank: 0 | 1 | 2;
  readonly followsLinks?: false;
};

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
  { relative: ".fx/skills", rank: 0, followsLinks: false },
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

/**
 * A skill's name and description. fx names a skill by its folder only when
 * SKILL.md has no frontmatter; frontmatter without a usable `name` makes the
 * skill invalid, and fx will not load it.
 */
function parseSkillMetadata(
  contents: string,
  folderName: string,
): { readonly name: string; readonly description?: string } | undefined {
  if (!/^---(?:\r?\n|$)/.test(contents)) {
    const name = nonEmptyTrimmed(folderName);
    return name === undefined ? undefined : { name };
  }
  // An opening `---` without a closing one is invalid frontmatter, not none.
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const name = nonEmptyTrimmed(record.name);
    if (name === undefined || name.includes("/") || name.includes("\\")) return undefined;
    const description = nonEmptyTrimmed(record.description);
    return { name, ...(description === undefined ? {} : { description }) };
  } catch {
    return undefined;
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
    readonly followsLinks: boolean;
  }> = [];
  for (let current = cwd; current !== home;) {
    for (const root of FX_WORKSPACE_ROOTS) {
      roots.push({
        directory: path.join(current, root.relative),
        scope: "project",
        rank: root.rank,
        followsLinks: root.followsLinks ?? true,
      });
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of FX_HOME_ROOTS) {
    roots.push({
      directory: path.join(home, root.relative),
      scope: "user",
      rank: root.rank,
      followsLinks: root.followsLinks ?? true,
    });
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
  readonly followsLinks: boolean;
}): Effect.fn.Return<
  ReadonlyArray<{ readonly skill: ServerProviderSkill; readonly folder: string }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* skipUnreadable(input.directory, fileSystem.readDirectory(input.directory));
  const skills: Array<{ readonly skill: ServerProviderSkill; readonly folder: string }> = [];
  for (const entry of entries ?? []) {
    // `readLink` succeeds only on a symlink.
    if (
      !input.followsLinks &&
      Option.isSome(yield* Effect.option(fileSystem.readLink(path.join(input.directory, entry))))
    ) {
      continue;
    }
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
    const metadata = contents === undefined ? undefined : parseSkillMetadata(contents, entry);
    if (metadata === undefined) continue;
    const folder = yield* skipUnreadable(
      skillPath,
      fileSystem.realPath(path.join(input.directory, entry)),
    );
    skills.push({
      folder: folder ?? path.join(input.directory, entry),
      skill: {
        name: metadata.name,
        path: skillPath,
        scope: input.scope,
        enabled: true,
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
      },
    });
  }
  return skills;
});

/**
 * Skills in fx's menu order. Like fx, a folder reached twice (a symlinked
 * root) counts once. A name two different skills share stays listed but
 * can't be picked: fx refuses an ambiguous `$name`.
 */
export const discoverFxSkills = Effect.fn("discoverFxSkills")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  // fx reads skills only under a set HOME, and compares HOME and the
  // workspace by their real paths.
  const configuredHome = input.environment.HOME?.trim();
  if (!configuredHome) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
  const home = yield* realPath(configuredHome);
  const cwd = yield* realPath(input.cwd);
  const path = yield* Path.Path;
  const seenFolders = new Set<string>();
  const found: Array<{ readonly skill: ServerProviderSkill; readonly rank: number }> = [];
  for (const root of skillRoots(path, cwd, home)) {
    for (const { skill, folder } of yield* discoverSkillsInRoot(root)) {
      if (seenFolders.has(folder)) continue;
      seenFolders.add(folder);
      found.push({ skill, rank: root.rank });
    }
  }
  const nameCounts = new Map<string, number>();
  for (const { skill } of found) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }
  return found
    .sort((left, right) => left.rank - right.rank)
    .map(({ skill }) =>
      (nameCounts.get(skill.name) ?? 0) > 1 ? { ...skill, userInvocable: false } : skill,
    );
});
