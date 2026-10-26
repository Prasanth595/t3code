import {
  getIconForType,
  SVGSpriteSheet,
  type CodeViewScrollTarget,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { useId, type KeyboardEvent, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { isEditableFocused } from "~/lib/editableFocus";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { Kbd } from "../ui/kbd";
import {
  diffChangeTargets,
  stepDiffChange,
  type DiffFocusPosition,
} from "./diffFocusNavigation.logic";

const DIFF_FOCUS_LAYOUT_MIN_WIDTH = 800;

export interface DiffFocusFile {
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
  readonly path: string;
}

export function useDiffFocusLayoutMeasure(setWide: (wide: boolean) => void, onNarrow: () => void) {
  const handleNarrow = useStableCallback(onNarrow);
  return (element: HTMLElement | null) => {
    if (element === null) return;
    let wasWide = false;
    return observeResize(element, (entries) => {
      const next = (entries.at(-1)?.contentRect.width ?? 0) >= DIFF_FOCUS_LAYOUT_MIN_WIDTH;
      if (wasWide && !next) handleNarrow();
      wasWide = next;
      setWide(next);
    });
  };
}

export interface DiffFocusSelection {
  readonly fileKey: string;
  readonly changeIndex: number;
}

export function createDiffFocusNavigation<TFile extends DiffFocusFile>({
  files,
  position,
  setPosition,
  reveal,
}: {
  files: ReadonlyArray<TFile>;
  position: DiffFocusSelection | null;
  setPosition: (position: DiffFocusSelection) => void;
  reveal: (fileKey: string, target?: CodeViewScrollTarget) => void;
}) {
  const foundIndex =
    position === null ? -1 : files.findIndex((file) => file.fileKey === position.fileKey);
  const fileIndex = Math.max(0, foundIndex);
  const selected = files[fileIndex] ?? null;
  const changeIndex = foundIndex >= 0 && position !== null ? position.changeIndex : -1;
  const changeCount = selected === null ? 0 : diffChangeTargets(selected.fileDiff).length;

  const revealPosition = (next: DiffFocusPosition) => {
    const file = files[next.fileIndex];
    if (file === undefined) return;
    const change =
      next.changeIndex < 0 ? undefined : diffChangeTargets(file.fileDiff)[next.changeIndex];
    reveal(
      file.fileKey,
      change === undefined
        ? undefined
        : {
            type: "line",
            id: file.fileKey,
            lineNumber: change.lineNumber,
            side: change.side,
            align: "center",
          },
    );
  };
  const goTo = (next: DiffFocusPosition) => {
    const file = files[next.fileIndex];
    if (file === undefined) return;
    setPosition({ fileKey: file.fileKey, changeIndex: next.changeIndex });
    revealPosition(next);
  };
  const selectFile = (index: number) => {
    const clamped = Math.min(files.length - 1, Math.max(0, index));
    if (clamped !== fileIndex || changeIndex !== -1) goTo({ fileIndex: clamped, changeIndex: -1 });
  };

  return {
    files,
    selected,
    fileIndex,
    changeIndex,
    changeCount,
    selectFile,
    revealCurrent: () => revealPosition({ fileIndex, changeIndex }),
    selectPath: (path: string) => {
      const index = files.findIndex((file) => file.path === path);
      if (index >= 0) goTo({ fileIndex: index, changeIndex: -1 });
    },
    stepFile: (delta: 1 | -1) => selectFile(fileIndex + delta),
    stepChange: (delta: 1 | -1) => {
      const next = stepDiffChange(
        { fileIndex, changeIndex },
        files.map((file) => diffChangeTargets(file.fileDiff).length),
        delta,
      );
      if (next.fileIndex !== fileIndex || next.changeIndex !== changeIndex) goTo(next);
    },
  };
}

type DiffFocusNavigation = ReturnType<typeof createDiffFocusNavigation>;

const DIFF_FOCUS_KEYS: Record<string, (navigation: DiffFocusNavigation) => void> = {
  j: (navigation) => navigation.stepFile(1),
  k: (navigation) => navigation.stepFile(-1),
  n: (navigation) => navigation.stepChange(1),
  p: (navigation) => navigation.stepChange(-1),
};

export function DiffFocusKeyboard({
  navigation,
  className,
  children,
}: {
  navigation: DiffFocusNavigation | null;
  className: string;
  children: ReactNode;
}) {
  if (navigation === null) return <div className={className}>{children}</div>;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isEditableFocused(event.target)) return;
    const action = DIFF_FOCUS_KEYS[event.key];
    if (action === undefined) return;
    event.preventDefault();
    action(navigation);
  };
  return (
    // The root takes focus from clicks inside the shadow-rooted diff so its keys still reach here.
    <div
      tabIndex={-1}
      data-owned-keys={Object.keys(DIFF_FOCUS_KEYS).join("")}
      className={cn(className, "outline-none")}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

const CHANGE_LABELS: Record<FileDiffMetadata["type"], string> = {
  new: "Added",
  change: "Modified",
  deleted: "Deleted",
  "rename-pure": "Renamed",
  "rename-changed": "Renamed",
};

// Matches the viewer header icons; the pierre themes render modified as #009fff in both schemes.
const CHANGE_ICON_CLASS_NAMES: Record<FileDiffMetadata["type"], string> = {
  new: "text-diff-addition",
  change: "text-[#009fff]",
  deleted: "text-diff-deletion",
  "rename-pure": "text-[#009fff]",
  "rename-changed": "text-[#009fff]",
};

// The viewer's sprite lives in its shadow roots, so `<use href>` cannot reach it from here.
const changeIconMarkup = new Map(
  Array.from(
    SVGSpriteSheet.matchAll(/<symbol id="([^"]+)" viewBox="0 0 16 16">([\s\S]*?)<\/symbol>/g),
    ([, id, markup]) => [id, markup] as const,
  ),
);

function DiffChangeIcon({ type }: { type: FileDiffMetadata["type"] }) {
  return (
    <svg
      role="img"
      aria-label={CHANGE_LABELS[type]}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn("size-4 shrink-0", CHANGE_ICON_CLASS_NAMES[type])}
      dangerouslySetInnerHTML={{ __html: changeIconMarkup.get(getIconForType(type)) ?? "" }}
    />
  );
}

const LIST_KEYS: Record<string, (navigation: DiffFocusNavigation) => void> = {
  ArrowDown: (navigation) => navigation.stepFile(1),
  ArrowUp: (navigation) => navigation.stepFile(-1),
  Home: (navigation) => navigation.selectFile(0),
  End: (navigation) => navigation.selectFile(navigation.files.length - 1),
};

// scrollIntoView would also scroll the panel's overflow-hidden ancestors.
function keepRowInView(row: HTMLElement | null) {
  const list = row?.parentElement;
  if (!row || !list) return;
  const top = row.offsetTop - list.clientTop;
  const bottom = top + row.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

export function DiffFocusFileList({
  ariaLabel,
  navigation,
  footer,
}: {
  ariaLabel: string;
  navigation: DiffFocusNavigation;
  footer?: ReactNode;
}) {
  const idPrefix = useId();
  const { files } = navigation;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto px-1 tabular-nums">{files.length}</span>
      </div>
      <div
        role="listbox"
        aria-label={ariaLabel}
        aria-activedescendant={
          navigation.selected ? `${idPrefix}-${navigation.fileIndex}` : undefined
        }
        tabIndex={0}
        className="group/list relative min-h-0 flex-1 overflow-y-auto p-1 outline-none"
        onKeyDown={(event) => {
          const action = LIST_KEYS[event.key];
          if (action === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          action(navigation);
        }}
      >
        {files.map((file, index) => {
          const selected = index === navigation.fileIndex;
          const slash = file.path.lastIndexOf("/");
          return (
            <div
              key={file.fileKey}
              id={`${idPrefix}-${index}`}
              ref={selected ? keepRowInView : undefined}
              role="option"
              aria-selected={selected}
              className={cn(
                "flex h-6 cursor-default items-center gap-2 rounded-md px-2 text-xs [contain-intrinsic-size:auto_1.5rem] [content-visibility:auto]",
                selected
                  ? "bg-foreground/12 group-focus/list:bg-primary/20"
                  : "hover:bg-foreground/7",
              )}
              onClick={() => navigation.selectFile(index)}
            >
              <span className="min-w-0 flex-1 truncate text-left" dir="rtl">
                <bdi>
                  {slash >= 0 ? (
                    <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                  ) : null}
                  <span className="font-medium text-foreground">{file.path.slice(slash + 1)}</span>
                </bdi>
              </span>
              <DiffChangeIcon type={file.fileDiff.type} />
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          file
        </span>
        <span className="flex items-center gap-1">
          <Kbd>n</Kbd>
          <Kbd>p</Kbd>
          change
        </span>
        {navigation.changeCount > 0 ? (
          <span className="ml-auto tabular-nums">
            {navigation.changeIndex < 0 ? "–" : navigation.changeIndex + 1} /{" "}
            {navigation.changeCount}
          </span>
        ) : null}
      </div>
      {footer}
    </div>
  );
}
