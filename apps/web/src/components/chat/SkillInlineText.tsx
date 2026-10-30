import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  threadRef: ScopedThreadRef | undefined;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const { start, end, skill, rawText } of matchInlineSkills(props.text, props.skills)) {
    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    nodes.push(
      <SkillChipPopover
        key={`${start}:${skill.name}`}
        label={formatProviderSkillDisplayName(skill)}
        description={skillPopoverDescription(skill)}
        copyMarkdown={rawText}
        onViewInstructions={skillInstructionsOpener(props.threadRef, skill)}
      />,
    );
    cursor = end;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<ServerProviderSkill>,
  threadRef: ScopedThreadRef | undefined,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} threadRef={threadRef} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom markdown components replace intrinsic types; check their hast tags.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills, threadRef),
    );
  });
}

export function skillPopoverDescription(
  skill: Pick<ServerProviderSkill, "description" | "shortDescription">,
) {
  return skill.description?.trim() || skill.shortDescription?.trim() || null;
}

export function skillInstructionsOpener(
  threadRef: ScopedThreadRef | null | undefined,
  skill: Pick<ServerProviderSkill, "path"> | undefined,
) {
  if (!threadRef || !skill?.path) return undefined;
  return () => useRightPanelStore.getState().openFile(threadRef, skill.path);
}

/**
 * Shared shell for the skill chip in the composer and in sent messages, so
 * both surfaces keep the same RightPanelTab look; the composer adds pointer
 * and hover classes via `className`. Border and tint colors reuse the
 * ContextChip skill accent so the chip still reads as the old purple chip.
 */
function SkillTabChipShell(props: React.ComponentProps<typeof ContextChip>) {
  return (
    <ContextChip
      kind="skill"
      className="group/tab h-6 max-w-36 gap-0.5 rounded-md border pr-2 pl-1.5 text-xs bg-accent/40 text-foreground [button:enabled&]:hover:bg-accent/60"
      {...props}
    />
  );
}

/**
 * Resting tinted badge; PanelTabCloseButton swaps it for its X on hover
 * (group/tab), sent messages keep it permanently.
 */
function SkillTabChipBadge() {
  return (
    <span className="flex size-3 shrink-0 items-center justify-center rounded-[5px] bg-(--context-chip-accent)/17 text-(--context-chip-foreground) [&_svg]:size-2 [&_svg]:[stroke-width:2.5]">
      <SkillChipIcon />
    </span>
  );
}

export function SkillChipPopover(props: {
  label: string;
  description: string | null | undefined;
  copyMarkdown?: string | undefined;
  onViewInstructions: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const details = (
    <>
      <PopoverTitle className="sr-only">{`Skill ${props.label}`}</PopoverTitle>
      <div className="space-y-3 p-2 text-sm">
        <p className="font-medium">{props.label}</p>
        <p>{props.description || "No description is available for this skill."}</p>
        {props.onViewInstructions ? (
          <Button variant="outline" size="sm" onClick={props.onViewInstructions}>
            View instructions
          </Button>
        ) : null}
      </div>
    </>
  );
  return (
    <Popover>
      {props.onRemove ? (
        <SkillTabChipShell className="cursor-pointer hover:bg-accent/60">
          <PanelTabCloseButton label={`Remove ${props.label} skill`} onClick={props.onRemove}>
            <SkillTabChipBadge />
          </PanelTabCloseButton>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 cursor-pointer items-center"
                aria-label={`Skill ${props.label}. Show details`}
              />
            }
          >
            <ContextChipLabel>{props.label}</ContextChipLabel>
          </PopoverTrigger>
        </SkillTabChipShell>
      ) : (
        <PopoverTrigger
          render={
            <SkillTabChipShell
              render={<button type="button" />}
              aria-label={`Skill ${props.label}. Show details`}
              data-markdown-copy={props.copyMarkdown}
            />
          }
        >
          <SkillTabChipBadge />
          <ContextChipLabel>{props.label}</ContextChipLabel>
        </PopoverTrigger>
      )}
      <PopoverPopup side="top" width="lg" padding="compact">
        {details}
      </PopoverPopup>
    </Popover>
  );
}

function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
