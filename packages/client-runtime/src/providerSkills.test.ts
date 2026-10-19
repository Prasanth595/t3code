import {
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillMention,
  formatProviderSkillMenuDescription,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("offers distinct, path-labelled picks for same-name files without duplicate rows", () => {
    const first = {
      name: "review.v2",
      path: "/home/me/skills/review/SKILL.md",
      enabled: true,
      description: "Review code",
    };
    const second = { ...first, path: "/repo/my skills/100%/review/SKILL.md" };
    const skills = [first, second, { ...second, path: second.path.replaceAll("/", "\\") }];
    const rows = getProviderSkillsForSlashMenu(skills, true);
    expect(rows).toEqual([first, second]);
    expect(rows.map((skill) => formatProviderSkillMenuDescription(skill, skills))).toEqual([
      `${first.path} · Review code`,
      `${second.path} · Review code`,
    ]);
    expect(
      rows.map(
        (skill) => collectComposerInlineTokens(`${formatProviderSkillMention(skill, skills)} `)[0],
      ),
    ).toMatchObject([
      { type: "skill", value: "review.v2", path: first.path },
      { type: "skill", value: "review.v2", path: second.path },
    ]);
  });

  it("keeps plain mentions for unique invocable skills", () => {
    const skill = { name: "review", path: "/repo/review/SKILL.md", enabled: true };
    expect(formatProviderSkillMention(skill, [skill])).toBe("$review");
    expect(
      formatProviderSkillMention(skill, [
        skill,
        { ...skill, path: "/other/SKILL.md", enabled: false },
      ]),
    ).toBe("$review");
    expect(
      formatProviderSkillMention(skill, [
        skill,
        { ...skill, path: "/other/SKILL.md", userInvocable: false },
      ]),
    ).toBe("$review");

    for (const path of ["acp://skill/review", "pi:skill:review", "https://example.com/SKILL.md"]) {
      const native = { ...skill, path };
      const duplicate = { ...native, path: `${path}/other` };
      expect(getProviderSkillsForSlashMenu([native, duplicate], true)).toEqual([native]);
      expect(formatProviderSkillMention(native, [native, duplicate])).toBe("$review");
      expect(collectComposerInlineTokens(`[$review](${path}) `)).toEqual([]);
    }
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("drops a skill the provider reserves for the agent", () => {
    const skills = [
      {
        name: "legacy-system-context",
        path: "/Users/matt/.claude/skills/legacy-system-context/SKILL.md",
        enabled: true,
        userInvocable: false,
      },
      {
        name: "deploy",
        path: "/Users/matt/.claude/skills/deploy/SKILL.md",
        enabled: true,
        userInvocationOnly: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "deploy",
    ]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("workspace provider snapshots", () => {
  it("uses the cwd snapshot after a provider session has populated it", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project", path: "/workspace/project-a/SKILL.md", enabled: true },
    ]);
    expect(resolveProviderSlashCommandsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project" },
    ]);
  });

  it("keeps the machine snapshot before this cwd has a provider snapshot", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-b")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
  });

  it("uses partial workspace skills and commands while keeping discovery retryable", () => {
    const partial = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommands: [{ name: "compact" }],
        slashCommandsPending: true,
      })),
    } satisfies ServerProvider;
    expect(resolveProviderSkillsForCwd(partial, "/workspace/project-a")).toEqual(
      provider.workspaceSnapshots[0]?.skills,
    );
    expect(resolveProviderSlashCommandsForCwd(partial, "/workspace/project-a")).toEqual([
      { name: "compact" },
    ]);
    expect(hasCompleteProviderWorkspaceSnapshot(partial, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-a")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-b")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(undefined, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, null)).toBe(false);
  });

  it("asks for a rescan once the workspace snapshot outlives its TTL", () => {
    const scannedAt = Date.parse("2026-01-01T00:01:00.000Z");
    const cwd = "/workspace/project-a";
    expect(hasCurrentProviderWorkspaceSnapshot(provider, cwd, scannedAt)).toBe(true);
    expect(
      hasCurrentProviderWorkspaceSnapshot(
        provider,
        cwd,
        scannedAt + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      hasCurrentProviderWorkspaceSnapshot(
        provider,
        cwd,
        scannedAt + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
      ),
    ).toBe(false);
    expect(hasCurrentProviderWorkspaceSnapshot(provider, "/workspace/project-b", scannedAt)).toBe(
      false,
    );
  });
});
