import type { CodeViewScrollTarget, FileDiffMetadata } from "@pierre/diffs";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { isEditableFocused } from "~/lib/editableFocus";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { Kbd } from "../ui/kbd";
import {
  diffChangeTargets,
  stepDiffChange,
  type DiffFocusPosition,
} from "./diffFocusNavigation.logic";
import { orderLikeDiffFileTree } from "./diffFileTree.logic";

const DIFF_FOCUS_LAYOUT_MIN_WIDTH = 960;

export interface DiffFocusFile {
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
  readonly path: string;
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

/** Steps files in the order the file tree shows them, not the diff's order. */
export function createDiffFocusNavigation<TFile extends DiffFocusFile>({
  files: diffFiles,
  position,
  setPosition,
  reveal,
  onSelect,
}: {
  files: ReadonlyArray<TFile>;
  position: DiffFocusSelection | null;
  setPosition: (position: DiffFocusSelection) => void;
  reveal: (fileKey: string, target?: CodeViewScrollTarget) => void;
  onSelect?: (file: TFile) => void;
}) {
  const files = orderLikeDiffFileTree(diffFiles, (file) => file.path);
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
    onSelect?.(file);
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
    changeIndex,
    changeCount,
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

export function DiffFocusKeyHints({ navigation }: { navigation: DiffFocusNavigation }) {
  return (
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
          {navigation.changeIndex < 0 ? "–" : navigation.changeIndex + 1} / {navigation.changeCount}
        </span>
      ) : null}
    </div>
  );
}
