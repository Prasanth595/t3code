import * as Option from "effect/Option";
import { skillOverridesEqual } from "@t3tools/shared/model";
import type { ProviderSkillOverrides } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class CodexSkillOverrideError extends Schema.TaggedError<CodexSkillOverrideError>()(
  "CodexSkillOverrideError",
  {
    reason: Schema.Literals([
      "unsupported-version",
      "unknown-skill",
      "conflicting-aliases",
      "globally-disabled",
      "relative-path",
      "session-policy-changed",
      "discovery-failed",
    ]),
  },
) {
  override get message() {
    return `Codex session skill overrides refused: ${this.reason}. Use discovered absolute SKILL.md paths in a fresh session with Codex 0.165.0 or newer.`;
  }
}

class CodexSkillPathError extends Schema.TaggedError<CodexSkillPathError>()("CodexSkillPathError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not resolve a Codex skill path.";
  }
}

const SkillConfig = Schema.Struct({ config: Schema.optional(Schema.Array(Schema.Json)) });
const decodeSkillConfig = Schema.decodeUnknownEffect(SkillConfig);

export function supportsCodexSkillOverrides(userAgent: string): boolean {
  const version = userAgent.match(/(?:^|\/)(\d+)\.(\d+)\.(\d+)/);
  return version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 165);
}

export const assertCodexSkillOverridesUnchanged = (
  requested: ProviderSkillOverrides | undefined,
  configured: ProviderSkillOverrides | undefined,
) =>
  skillOverridesEqual(requested, configured)
    ? Effect.void
    : Effect.fail(new CodexSkillOverrideError({ reason: "session-policy-changed" }));

export const resolveCodexSkillOverrides = Effect.fn("resolveCodexSkillOverrides")(
  function* (input: {
    readonly overrides: ProviderSkillOverrides;
    readonly skills: ReadonlyArray<{
      readonly name: string;
      readonly path: string;
      readonly enabled: boolean;
    }>;
    readonly baseConfig: Schema.Json | undefined;
    readonly userAgent: string;
  }) {
    const version = input.userAgent.match(/(?:^|\/)(\d+)\.(\d+)\.(\d+)/);
    if (!version || !supportsCodexSkillOverrides(input.userAgent)) {
      return yield* new CodexSkillOverrideError({ reason: "unsupported-version" });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillIdentity = Effect.fn("CodexSkillOverrides.fileIdentity")(
      function* (value: string) {
        const identity = yield* fs.realPath(value);
        const info = yield* fs.stat(identity);
        return Option.isSome(info.ino) ? `${info.dev}:${info.ino.value}` : identity;
      },
      Effect.mapError((cause) => new CodexSkillPathError({ cause })),
    );
    const discovered = yield* Effect.forEach(input.skills, (skill) =>
      skillIdentity(skill.path).pipe(Effect.map((identity) => ({ ...skill, identity }))),
    );
    const overrides = new Map<string, boolean>();
    for (const override of input.overrides) {
      if (!path.isAbsolute(override.path)) {
        return yield* new CodexSkillOverrideError({ reason: "relative-path" });
      }
      const identity = yield* skillIdentity(override.path);
      const aliases = discovered.filter((skill) => skill.identity === identity);
      if (aliases.length === 0) {
        return yield* new CodexSkillOverrideError({ reason: "unknown-skill" });
      }
      if (overrides.has(identity) && overrides.get(identity) !== override.enabled) {
        return yield* new CodexSkillOverrideError({ reason: "conflicting-aliases" });
      }
      // Codex user/managed disables are authoritative; do not claim a narrower enable wins.
      if (override.enabled && aliases.some((skill) => !skill.enabled)) {
        return yield* new CodexSkillOverrideError({ reason: "globally-disabled" });
      }
      overrides.set(identity, override.enabled);
    }
    const base = yield* decodeSkillConfig(input.baseConfig ?? {});
    const entries = discovered.flatMap((skill) => {
      const enabled = overrides.get(skill.identity);
      return enabled === undefined ? [] : [{ path: skill.path, enabled }];
    });
    return {
      config: [...(base.config ?? []), ...entries],
      providerVersion: `${version[1]}.${version[2]}.${version[3]}`,
      overrides: input.overrides,
      skills: discovered.map(({ identity, name, path, enabled }) => ({
        name,
        path,
        enabled: overrides.get(identity) ?? enabled,
      })),
    };
  },
);
