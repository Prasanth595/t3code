import type { ComposerContextRecord, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  composerChipSizeSuffix,
  contextChipIcon,
  contextChipPresentation,
  contextRecordFileName,
  type ContextChipIconRef,
  UNAVAILABLE_CONTEXT_CHIP_PRESENTATION,
} from "./composerChipPresentation";
import { resolveMarkdownLinkIcon } from "./markdownLinks";
import type { SelectableMarkdownSkill } from "../native/SelectableMarkdownText.types";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

export function enrichedContextLinkPresentation(
  href: string,
  records?: ReadonlyArray<ComposerContextRecord>,
): { accent?: string; icon: ContextChipIconRef; label?: string } | undefined {
  const reference = parseComposerContextHref(href);
  if (!reference) return undefined;
  const record = records?.find((candidate) => candidate.contextId === reference.contextId);
  const presentation =
    records && !record
      ? UNAVAILABLE_CONTEXT_CHIP_PRESENTATION
      : contextChipPresentation(reference.kind, record);
  const size = composerChipSizeSuffix(record);
  return {
    ...(presentation.accent ? { accent: presentation.accent } : {}),
    icon: contextChipIcon(presentation, contextRecordFileName(record)),
    ...(record && size ? { label: `${record.label} · ${size}` } : {}),
  };
}

export interface PullRequestChipState {
  readonly state: string;
  readonly isDraft: boolean;
}

export function pullRequestChipStates(links: ReadonlyArray<ThreadPullRequestLink>) {
  const newest = new Map<string, NonNullable<ThreadPullRequestLink["snapshot"]>>();
  for (const link of visibleThreadPullRequests(links)) {
    if (link.snapshot === null) continue;
    const key = threadPullRequestKeyOf(link);
    const known = newest.get(key);
    if (!known || compareDateTimeStrings(known.syncedAt, link.snapshot.syncedAt) < 0) {
      newest.set(key, link.snapshot);
    }
  }
  return new Map<string, PullRequestChipState>(
    Array.from(newest, ([key, snapshot]) => [
      key,
      { state: snapshot.state, isDraft: snapshot.isDraft },
    ]),
  );
}

export function enrichedChatLinkPresentation(
  href: string,
  pullRequestStates: ReadonlyMap<string, PullRequestChipState>,
  linkTexts: () => ReadonlySet<string> | undefined,
): { accent?: string; icon: ContextChipIconRef; label?: string } | undefined {
  if (parseThreadLinkHref(href)) return chatLinkChip(contextChipPresentation("thread"));
  const pullRequest = parseChangeRequestUrl(href);
  if (!pullRequest || resolveMarkdownLinkIcon(pullRequest.host) !== "github") return undefined;
  const label = `#${pullRequest.number}`;
  if ([...(linkTexts() ?? [])].some((text) => text !== href && text !== label)) return undefined;
  return chatLinkChip(
    contextChipPresentation("pull-request", {
      pullRequest: pullRequestStates.get(threadPullRequestKeyOf(pullRequest)),
    }),
    label,
  );
}

function chatLinkChip(presentation: ReturnType<typeof contextChipPresentation>, label?: string) {
  return {
    ...(presentation.accent ? { accent: presentation.accent } : {}),
    icon: { kind: "chip", name: presentation.icon ?? "circle-dashed" } as const,
    ...(label ? { label } : {}),
  };
}

export function enrichedLinkVariantPattern(url: string) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export const ENRICHED_INLINE_FILE_LINK_REGEX =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;

export function enrichedSkillLinkRegex(skills?: ReadonlyArray<SelectableMarkdownSkill>) {
  const names = [...new Set(skills?.map((skill) => skill.name) ?? [])].filter(Boolean);
  if (names.length === 0) return null;
  names.sort((a, b) => b.length - a.length);
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(?<![A-Za-z0-9_-])(?<!\\p{Sc})\\p{Sc}(?:${alternatives.join("|")})(?![A-Za-z0-9_-])`,
    "u",
  );
}

export function enrichedSkillDisplayName(skill: SelectableMarkdownSkill) {
  return (
    skill.displayName?.trim() ||
    skill.name
      .split(/[\s:_-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export function enrichedSkillReference(
  url: string,
  skills?: ReadonlyArray<SelectableMarkdownSkill>,
) {
  const match = /^\p{Sc}(.+)$/u.exec(url);
  return match ? skills?.find((skill) => skill.name === match[1]) : undefined;
}

export function enrichedSkillInstructionsPath(skill: SelectableMarkdownSkill) {
  return skill.path && !/^[a-z][a-z\d+.-]*:\/\//i.test(skill.path) ? skill.path : undefined;
}
