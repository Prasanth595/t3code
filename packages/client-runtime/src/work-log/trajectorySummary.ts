import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { claudeSkillInvocation, collectToolFilePaths } from "@t3tools/shared/toolActivity";

export interface AgentTrajectorySegment {
  readonly kind: "skills" | "tools";
  readonly label: string;
  readonly title: string;
  readonly details: ReadonlyArray<string>;
}

export type AgentTrajectorySummary = ReadonlyArray<AgentTrajectorySegment>;

const TOOL_NAMES: Partial<Record<OrchestrationV2TurnItem["type"], string>> = {
  command_execution: "Shell",
  file_change: "File edit",
  file_search: "File search",
  web_search: "Web search",
};

export function compactTrajectoryLabel(label: string): string {
  return label.replace(/^(?:Used |Called |Worked for |Continued for )(?=.)/su, "");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addSkillPath(path: string, skills: Set<string>) {
  const match = /(?:^|\/)([^/]+)\/SKILL\.md$/u.exec(path.replaceAll("\\", "/"));
  if (match?.[1]) skills.add(match[1]);
}

function addCommandSkills(command: string, skills: Set<string>) {
  // Only reading commands count; a skill path in an echo, search, or edit is not a skill read.
  for (const read of command.matchAll(
    /(?:^|[;&|\n])\s*(cat|sed|head|tail|bat|less|more)\s+([^;&|\n]+)/gu,
  )) {
    const args = read[2]!;
    if (
      read[1] === "sed" &&
      (/(?:^|\s)(?:-\w*i|--in-place)\b/u.test(args) || !/(?:^|\s)-n\b/u.test(args))
    )
      continue;
    for (const path of args.matchAll(/[^\s"'`<>]+[/\\]SKILL\.md/gu)) {
      addSkillPath(path[0], skills);
    }
  }
}

export function summarizeAgentTrajectory(
  items: Iterable<OrchestrationV2TurnItem>,
): AgentTrajectorySummary {
  const seen = new Set<string>();
  const tools = new Map<string, number>();
  const skills = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const toolName =
      item.type === "dynamic_tool" ? (item.toolName ?? "Tool") : TOOL_NAMES[item.type];
    if (toolName === undefined) continue;
    tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
    if (item.status !== "completed") continue;
    if (item.type !== "dynamic_tool" && item.type !== "command_execution") continue;
    if (item.type === "command_execution" && item.exitCode !== undefined && item.exitCode !== 0)
      continue;
    const name =
      item.type === "command_execution"
        ? "shell"
        : toolName.toLowerCase().split(/\.|__/u).at(-1)!.replaceAll("_", "");
    if (name === "skill") {
      const skill = claudeSkillInvocation("Skill", item.input);
      if (skill) skills.add(skill.name);
    } else if (["read", "readfile", "readtextfile"].includes(name)) {
      for (const path of collectToolFilePaths({ input: item.input })) addSkillPath(path, skills);
    } else if (
      ["bash", "shell", "terminal", "command", "execcommand", "runshellcommand"].includes(name)
    ) {
      const command = item.type === "command_execution" ? item.input : record(item.input)?.command;
      if (typeof command === "string") addCommandSkills(command, skills);
    }
  }
  const summary: AgentTrajectorySegment[] = [];
  if (skills.size > 0)
    summary.push({
      kind: "skills",
      label: `Used ${skills.size} skill${skills.size === 1 ? "" : "s"}`,
      title: "Skills used",
      details: [...skills].sort(),
    });
  if (tools.size > 0) {
    const count = [...tools.values()].reduce((sum, n) => sum + n, 0);
    summary.push({
      kind: "tools",
      label: `Called ${count} tool${count === 1 ? "" : "s"}`,
      title: "Tool calls",
      details: [...tools]
        .sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))
        .map(([name, n]) => `${name} · ${n} call${n === 1 ? "" : "s"}`),
    });
  }
  return summary;
}

export function trajectorySummariesEqual(
  a: AgentTrajectorySummary,
  b: AgentTrajectorySummary,
): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((segment, index) => {
        const other = b[index]!;
        return (
          segment.kind === other.kind &&
          segment.label === other.label &&
          segment.details.length === other.details.length &&
          segment.details.every((detail, detailIndex) => detail === other.details[detailIndex])
        );
      }))
  );
}
