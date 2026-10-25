import type { CodeViewScrollTarget, FileDiffMetadata } from "@pierre/diffs";
import type { GitStatus } from "@pierre/trees";
import {
  SquareArrowRightIcon,
  SquareDotIcon,
  SquareMinusIcon,
  SquarePlusIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { isEditableFocused } from "~/lib/editableFocus";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";
import { Kbd } from "../ui/kbd";
import {
  diffChangeTargets,
  stepDiffChange,
  type DiffFocusPosition,
} from "./diffFocusNavigation.logic";
import { toGitStatus } from "./diffFileTree.logic";

const DIFF_FOCUS_LAYOUT_MIN_WIDTH = 960;

export interface DiffFocusFile {
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function useDiffFocusLayoutWidth() {
  const [wide, setWide] = useState(false);
  const measureRef = (element: HTMLElement | null) => {
    if (element === null) return;
    return observeResize(element, (entries) => {
      setWide((entries.at(-1)?.contentRect.width ?? 0) >= DIFF_FOCUS_LAYOUT_MIN_WIDTH);
    });
  };
  return [wide, measureRef] as const;
}

export interface DiffFocusSelection {
  readonly fileKey: string;
  readonly changeIndex: number;
}

export function createDiffFocusNavigation({
  files,
  position,
  setPosition,
  reveal,
  onSelect,
}: {
  files: ReadonlyArray<DiffFocusFile>;
  position: DiffFocusSelection | null;
  setPosition: (position: DiffFocusSelection) => void;
  reveal: (fileKey: string, target?: CodeViewScrollTarget) => void;
  onSelect?: (fileIndex: number) => void;
}) {
  const foundIndex =
    position === null ? -1 : files.findIndex((file) => file.fileKey === position.fileKey);
  const fileIndex = Math.max(0, foundIndex);
  const selected = files[fileIndex] ?? null;
  const changeIndex = foundIndex >= 0 && position !== null ? position.changeIndex : -1;
  const changeCount = selected === null ? 0 : diffChangeTargets(selected.fileDiff).length;

  const goTo = (next: DiffFocusPosition) => {
    const file = files[next.fileIndex];
    if (file === undefined) return;
    setPosition({ fileKey: file.fileKey, changeIndex: next.changeIndex });
    onSelect?.(next.fileIndex);
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

  return {
    selected,
    fileIndex,
    changeIndex,
    changeCount,
    selectFile: (index: number) => goTo({ fileIndex: index, changeIndex: -1 }),
    selectPath: (path: string) => {
      const index = files.findIndex((file) => file.path === path);
      if (index >= 0) goTo({ fileIndex: index, changeIndex: -1 });
    },
    stepFile: (delta: 1 | -1) => {
      const index = Math.min(files.length - 1, Math.max(0, fileIndex + delta));
      if (index !== fileIndex) goTo({ fileIndex: index, changeIndex: -1 });
    },
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

const STATUS_ICONS: Record<GitStatus, { icon: LucideIcon; label: string; className: string }> = {
  added: { icon: SquarePlusIcon, label: "Added", className: "text-success" },
  untracked: { icon: SquarePlusIcon, label: "Added", className: "text-success" },
  modified: { icon: SquareDotIcon, label: "Modified", className: "text-warning" },
  deleted: { icon: SquareMinusIcon, label: "Deleted", className: "text-destructive" },
  renamed: { icon: SquareArrowRightIcon, label: "Renamed", className: "text-info" },
  ignored: { icon: SquareDotIcon, label: "Ignored", className: "text-muted-foreground" },
};

export function DiffFocusLayout({
  ariaLabel,
  files,
  navigation,
  listFooter,
  children,
}: {
  ariaLabel: string;
  files: ReadonlyArray<DiffFocusFile>;
  navigation: DiffFocusNavigation;
  listFooter?: ReactNode;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isEditableFocused(event.target)) return;
    const inList = listRef.current?.contains(event.target as Node) === true;
    switch (event.key) {
      case "j":
        navigation.stepFile(1);
        break;
      case "k":
        navigation.stepFile(-1);
        break;
      case "n":
        navigation.stepChange(1);
        break;
      case "p":
        navigation.stepChange(-1);
        break;
      case "ArrowDown":
        if (!inList) return;
        navigation.stepFile(1);
        break;
      case "ArrowUp":
        if (!inList) return;
        navigation.stepFile(-1);
        break;
      case "Home":
        if (!inList) return;
        navigation.selectFile(0);
        break;
      case "End":
        if (!inList) return;
        navigation.selectFile(files.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    // The root takes focus from clicks inside the shadow-rooted diff so its keys still reach here.
    <div
      tabIndex={-1}
      data-owned-keys="jknp"
      className="flex min-h-0 flex-1 overflow-hidden outline-none"
      onKeyDown={onKeyDown}
    >
      <aside className="flex w-[min(20rem,32%)] min-w-56 shrink-0 flex-col border-r border-border/60">
        <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {files.length} changed {files.length === 1 ? "file" : "files"}
          </span>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={
            navigation.selected ? `diff-focus-file-${navigation.fileIndex}` : undefined
          }
          tabIndex={0}
          className="group/list min-h-0 flex-1 overflow-y-auto py-1 outline-none"
        >
          {files.map((file, index) => {
            const selected = index === navigation.fileIndex;
            const status = STATUS_ICONS[toGitStatus(file.fileDiff)];
            const slash = file.path.lastIndexOf("/");
            return (
              <div
                key={file.fileKey}
                id={`diff-focus-file-${index}`}
                ref={selected ? (row) => row?.scrollIntoView({ block: "nearest" }) : undefined}
                role="option"
                aria-selected={selected}
                className={cn(
                  "mx-1 flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-xs [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]",
                  selected
                    ? "bg-foreground/12 group-focus/list:bg-primary/25"
                    : "hover:bg-foreground/7",
                )}
                onClick={() => navigation.selectFile(index)}
              >
                <span className="min-w-0 flex-1 truncate text-left" dir="rtl">
                  <bdi>
                    {slash >= 0 ? (
                      <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                    ) : null}
                    <span className="text-foreground">{file.path.slice(slash + 1)}</span>
                  </bdi>
                </span>
                {hasNonZeroStat(file) ? (
                  <DiffStatLabel
                    additions={file.additions}
                    deletions={file.deletions}
                    layout="inline"
                    className="shrink-0 text-2xs"
                  />
                ) : null}
                <status.icon
                  role="img"
                  aria-label={status.label}
                  className={cn("size-3.5 shrink-0", status.className)}
                />
              </div>
            );
          })}
        </div>
        {listFooter}
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
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
