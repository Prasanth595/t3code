import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  AtSignIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MousePointerClickIcon,
  PencilIcon,
  QuoteIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { FileTagChipContent } from "~/components/chat/FileTagChip";
import { SkillChipIcon } from "~/components/chat/SkillInlineText";
import { TerminalContextInlineChip } from "~/components/chat/TerminalContextInlineChip";
import { ContextChip, ContextChipAction, ContextChipLabel } from "~/components/ContextChip";
import {
  ContextChipPopover,
  ContextChipShell,
  FileChip,
  ImageChipButton,
  PULL_REQUEST_CHIP_KINDS,
  UnresolvedChip,
} from "~/components/contextChipParts";
import { PULL_REQUEST_STATE_PRESENTATION } from "~/components/pullRequest/pullRequestIcons";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";

/**
 * Dev-only review page for the context chip padding change. Every row renders the real chip
 * components twice; the "Before" column restores the previous metrics with the scoped,
 * unlayered CSS below, which outranks Tailwind's layered utilities.
 */
const COMPARISON_CSS = `
[data-chip-column="before"] [data-slot="context-chip"] { height: 1.41em; padding-inline: 0.5em; }
[data-chip-column="before"] [data-slot="context-chip"] svg:not([data-slot="context-chip-action"] svg) { width: 1.17em; height: 1.17em; }
[data-chip-column="before"] [data-slot="context-chip"] > img { width: 1.17em; height: 1.17em; margin-left: 0; }
[data-chip-guides] [data-slot="context-chip"] :is(svg, img, [data-slot="context-chip-label"]) { outline: 1px dashed color-mix(in srgb, currentColor 55%, transparent); }
`;

const FONT_SIZES = ["12", "14", "16", "18", "20"] as const;
type FontSize = (typeof FONT_SIZES)[number];

const PR_STATES = ["open", "draft", "merged", "closed"] as const;

const TERMINAL_TEXT = "$ vp test run\n✓ ContextChip renders\n✗ composer keeps chip selection\n";

/** A small gradient PNG so image chips get a real thumbnail and a sampled accent. */
function sampleImage(from: string, to: string): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const gradient = context.createLinearGradient(0, 0, 32, 32);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 32);
  return canvas.toDataURL("image/png");
}

function ChipComparisonPage() {
  const { resolvedTheme: theme } = useTheme();
  const [fontSize, setFontSize] = useState<FontSize>("14");
  const [guides, setGuides] = useState(false);
  const [images] = useState(() => ({
    dark: sampleImage("#f8b4a0", "#6b4c9a"),
    light: sampleImage("#fefce8", "#e0f2fe"),
  }));

  const fileMention = (path: string, label: string) => (
    <ContextChip kind="mention" render={<button type="button" />} aria-label={`Preview ${path}`}>
      <FileTagChipContent path={path} label={label} theme={theme} />
    </ContextChip>
  );
  const skill = (
    <ContextChip kind="skill">
      <SkillChipIcon />
      <ContextChipLabel>frontend-design</ContextChipLabel>
    </ContextChip>
  );
  const terminal = (
    <TerminalContextInlineChip
      label="Terminal 1 lines 12-40"
      terminalLabel="Terminal 1"
      lineStart={12}
      lineEnd={40}
      text={TERMINAL_TEXT}
      detailsMode="popover"
    />
  );
  const pullRequest = (state: (typeof PR_STATES)[number], number: string) => (
    <PullRequestStateChip state={state} number={number} />
  );
  const image = (
    <ImageChipButton name="composer-before.png" previewUrl={images.dark} size="248 KB" />
  );
  const thread = (
    <ContextChipShell kind="thread" icon={<MessagesSquareIcon />} label="Sidebar perf audit" />
  );
  const composerCitation = (
    <ContextChip kind="citation" contentEditable={false}>
      <span className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm">
        <QuoteIcon aria-hidden="true" />
        <ContextChipLabel className="max-w-[16em]">“keep chips in em”</ContextChipLabel>
      </span>
      <ContextChipAction aria-label="Edit citation comment">
        <PencilIcon aria-hidden="true" />
      </ContextChipAction>
    </ContextChip>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <style>{COMPARISON_CSS}</style>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <h1 className="truncate font-medium text-sm">Context chip comparison</h1>
            <div className="ml-auto flex items-center gap-4 text-muted-foreground text-xs">
              <label className="flex items-center gap-2">
                Guides
                <Switch size="sm" checked={guides} onCheckedChange={setGuides} />
              </label>
              <ToggleGroup
                aria-label="Prompt font size"
                variant="segmented"
                value={[fontSize]}
                onValueChange={(value) => {
                  const next = FONT_SIZES.find((size) => size === value[0]);
                  if (next) setFontSize(next);
                }}
              >
                {FONT_SIZES.map((size) => (
                  <Toggle key={size} value={size} aria-label={`${size}px`}>
                    {size}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <p className="max-w-3xl text-muted-foreground text-sm">
              Each row renders the real chip twice. Before: height 1.41em, padding 0.5em on both
              sides, icons and image thumbnails at 1.17em. After: height 1.72em, padding 6px left
              and 10px right, icons at 1.06em, thumbnails filling the chip with a matching inset.
              The size control changes the text size of both columns, like the prompt font-size
              preference.
            </p>

            <div
              {...(guides ? { "data-chip-guides": "" } : {})}
              style={{ fontSize: `${fontSize}px` }}
            >
              <Section title="Kinds and icons">
                <Row label="Neutral" note="No kind">
                  <ContextChipShell icon={<AtSignIcon />} label="neutral" />
                </Row>
                <Row label="File mention" note="Pierre file-type icons">
                  {fileMention("apps/web/src/components/ContextChip.tsx", "ContextChip.tsx")}{" "}
                  {fileMention("README.md", "README.md")}{" "}
                  {fileMention("apps/web/package.json", "package.json")}
                </Row>
                <Row label="Skill" note="Inline SVG wrapped in a span">
                  {skill}
                </Row>
                <Row label="Terminal excerpt" note="Opens a popover">
                  {terminal}
                </Row>
                <Row label="Browser element / annotation">
                  <ContextChipShell
                    kind="element"
                    icon={<MousePointerClickIcon />}
                    label="button.send"
                  />{" "}
                  <ContextChipShell
                    kind="preview-annotation"
                    icon={<MousePointerClickIcon />}
                    label="Annotation 1"
                  />
                </Row>
                <Row label="Review comment">
                  <ContextChipShell
                    kind="review-comment"
                    icon={<MessageCircleIcon />}
                    label="Comment on L42"
                  />
                </Row>
                <Row label="Pull requests" note="Open, draft, merged, closed">
                  {pullRequest("open", "18509")} {pullRequest("draft", "18520")}{" "}
                  {pullRequest("merged", "18516")} {pullRequest("closed", "18471")}
                </Row>
                <Row label="Thread">{thread}</Row>
                <Row label="Citation" note="Sent message, opens a popover">
                  <ContextChipPopover
                    kind="citation"
                    icon={<QuoteIcon />}
                    label="“keep chips in em”"
                    accessibleLabel="Quoted assistant text"
                  >
                    <p className="p-2 text-sm">Keep chips in em so they scale with the prompt.</p>
                  </ContextChipPopover>
                </Row>
                <Row label="Citation in composer" note="Trailing action button">
                  {composerCitation}
                </Row>
              </Section>

              <Section title="Attachments">
                <Row label="Image" note="Dark and light thumbnails">
                  {image}{" "}
                  <ImageChipButton name="whiteboard.png" previewUrl={images.light} size="96 KB" />
                </Row>
                <Row label="Image without preview" note="Falls back to an icon">
                  <ImageChipButton name="pasted-image.png" previewUrl={undefined} size="1.4 MB" />
                </Row>
                <Row label="Image with suffix">
                  <ImageChipButton
                    name="screenshot.png"
                    previewUrl={images.dark}
                    size="512 KB"
                    suffix="uploading"
                  />
                </Row>
                <Row label="File and video">
                  <FileChip
                    name="chip-spec.pdf"
                    size="1.2 MB"
                    isVideo={false}
                    theme={theme}
                    accessibleLabel="File attachment, chip-spec.pdf"
                    tooltip="chip-spec.pdf"
                    onOpen={() => {}}
                  />{" "}
                  <FileChip
                    name="repro.mov"
                    size="8.4 MB"
                    isVideo
                    theme={theme}
                    accessibleLabel="Video attachment, repro.mov"
                    tooltip="repro.mov"
                  />
                </Row>
                <Row label="Long file name" note="Middle-truncated">
                  <FileChip
                    name="design-review-export-final-final-v3-with-comments-copy.pdf"
                    size="3.1 MB"
                    isVideo={false}
                    theme={theme}
                    accessibleLabel="File attachment"
                    tooltip="design-review-export-final-final-v3-with-comments-copy.pdf"
                  />
                </Row>
              </Section>

              <Section title="States">
                <Row label="Unresolved" note="Dashed border">
                  <UnresolvedChip label="deleted-file.ts" tooltip="This file no longer exists" />
                </Row>
                <Row label="Invalid" note="Expired terminal, failed upload">
                  <TerminalContextInlineChip
                    label="Terminal 1 lines 12-40"
                    terminalLabel="Terminal 1"
                    lineStart={12}
                    lineEnd={40}
                    text=""
                    detailsMode="tooltip"
                    expired
                  />{" "}
                  <FileChip
                    name="broken.zip"
                    size="0 B"
                    isVideo={false}
                    theme={theme}
                    accessibleLabel="File attachment"
                    tooltip="Upload failed"
                    error
                  />
                </Row>
                <Row label="Disabled">
                  <FileChip
                    name="locked.pdf"
                    size="88 KB"
                    isVideo={false}
                    theme={theme}
                    accessibleLabel="File attachment"
                    tooltip="locked.pdf"
                    disabled
                    onOpen={() => {}}
                  />
                </Row>
                <Row label="Hover and focus" note="Hover, or Tab onto it">
                  {fileMention("apps/web/src/components/ContextChip.tsx", "ContextChip.tsx")}
                </Row>
                <Row label="Selected in composer" note="Arrowed onto the chip">
                  <div className="composer-tiptap">
                    <span className="ProseMirror-selectednode relative inline-flex items-center align-middle leading-none">
                      {skill}
                    </span>
                  </div>
                </Row>
                <Row label="Range-selected in composer" note="Inside a text selection">
                  <div className="composer-tiptap ProseMirror-focused">
                    <span className="composer-chip-range-selected relative inline-flex items-center align-middle leading-none">
                      {skill}
                    </span>
                  </div>
                </Row>
                <Row label="Narrow container" note="Label truncates">
                  <div className="max-w-40">
                    <ContextChipShell
                      kind="thread"
                      icon={<MessagesSquareIcon />}
                      label="A very long thread title that cannot fit"
                    />
                  </div>
                </Row>
              </Section>

              <Section title="In running text">
                <Row label="Composer" note="Relaxed line height, wrapping">
                  <div className="composer-tiptap rounded-2xl border border-border bg-card p-3 leading-relaxed">
                    Rework{" "}
                    {fileMention("apps/web/src/components/ContextChip.tsx", "ContextChip.tsx")} so
                    it follows {skill}. The failure is in {terminal}, and{" "}
                    {pullRequest("open", "18509")} touched the same code. Mockup: {image}, context
                    from {thread} and {composerCitation}
                  </div>
                </Row>
                <Row label="User message">
                  <div className="rounded-2xl bg-message p-3 text-message-foreground leading-relaxed">
                    Compare {fileMention("apps/web/src", "src")} with{" "}
                    {pullRequest("merged", "18516")} and apply {skill} to{" "}
                    <FileChip
                      name="chip-spec.pdf"
                      size="1.2 MB"
                      isVideo={false}
                      theme={theme}
                      accessibleLabel="File attachment, chip-spec.pdf"
                      tooltip="chip-spec.pdf"
                    />
                    .
                  </div>
                </Row>
                <Row label="Assistant markdown" note="File link chip">
                  <div className="chat-markdown leading-relaxed">
                    I read{" "}
                    <ContextChip
                      kind="mention"
                      render={<a href="#chip" />}
                      className="chat-markdown-file-link"
                    >
                      <FileTagChipContent
                        path="apps/web/src/components/contextChipParts.tsx"
                        label="contextChipParts.tsx"
                        theme={theme}
                      />
                    </ContextChip>{" "}
                    and the excerpt from {terminal}. The regression came from{" "}
                    {pullRequest("closed", "18471")}.
                  </div>
                </Row>
              </Section>
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function PullRequestStateChip(props: { state: (typeof PR_STATES)[number]; number: string }) {
  const { Icon, label } = PULL_REQUEST_STATE_PRESENTATION[props.state];
  return (
    <ContextChipShell
      kind={PULL_REQUEST_CHIP_KINDS[props.state]}
      icon={<Icon />}
      label={`#${props.number}`}
      tooltip={`${label} pull request`}
    />
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-1 grid grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-6 border-b border-border pb-2 text-muted-foreground text-xs">
        <h2 className="font-medium text-foreground text-sm">{props.title}</h2>
        <span>Before</span>
        <span>After</span>
      </div>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-6 border-b border-border/60 py-3">
      <div className="text-xs">
        <div className="font-medium text-foreground">{props.label}</div>
        {props.note ? <div className="text-muted-foreground">{props.note}</div> : null}
      </div>
      <div data-chip-column="before" className="min-w-0">
        {props.children}
      </div>
      <div data-chip-column="after" className="min-w-0">
        {props.children}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dev/chips")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: ChipComparisonPage,
});
