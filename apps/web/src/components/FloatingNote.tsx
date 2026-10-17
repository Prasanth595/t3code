"use client";

import { MoveDiagonal2Icon, NotebookPenIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { Button } from "./ui/button";

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 520;
const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 320;

const NoteEditor = lazy(() => import("./NoteEditor"));

export interface FloatingNoteProps {
  threadKey: string | null;
  /** Server-persisted markdown note for the thread, or null when empty. */
  note: string | null;
  /** Persist a note edit. Call with null to clear the note. */
  onSave: (note: string | null) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function FloatingNote({ threadKey, note, onSave }: FloatingNoteProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? note ?? "";
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<string | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);
  const flushPendingSave = useStableCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending !== null && pending !== (note ?? "")) {
      onSave(pending.length === 0 ? null : pending);
    }
  });

  const scheduleSave = useStableCallback((value: string) => {
    setDraft(value);
    pendingSaveRef.current = value;
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(flushPendingSave, 600);
  });

  // Flush the debounced save when the widget unmounts or switches threads.
  useEffect(() => flushPendingSave, [flushPendingSave]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const current = size;
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      width: current.width,
      height: current.height,
    };
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (start === null) return;
    event.preventDefault();
    setSize({
      width: clamp(start.width + (event.clientX - start.startX), MIN_WIDTH, MAX_WIDTH),
      height: clamp(start.height + (event.clientY - start.startY), MIN_HEIGHT, MAX_HEIGHT),
    });
  };

  const endResize = () => {
    resizeRef.current = null;
  };

  if (threadKey === null) return null;

  const hasNote = note != null && note.length > 0;

  return (
    <div className="pointer-events-none absolute top-3 right-3 z-30 flex flex-col items-end gap-2">
      {open ? (
        <div
          className="floating-surface-motion pointer-events-auto relative flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-lg/5"
          style={{ width: size.width, height: size.height }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold">Note</span>
            <div className="flex items-center gap-1">
              <span className="text-3xs text-muted-foreground">Markdown</span>
              <Button
                aria-label="Close note"
                size="icon-micro"
                variant="ghost"
                onClick={() => {
                  flushPendingSave();
                  setOpen(false);
                }}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>

          <Suspense
            fallback={<div className="p-3 text-xs text-muted-foreground">Loading editor…</div>}
          >
            <NoteEditor value={text} onChange={scheduleSave} onBlur={flushPendingSave} />
          </Suspense>

          <div
            aria-hidden="true"
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            className="absolute right-0 bottom-0 z-10 flex size-4 cursor-nwse-resize touch-none items-center justify-center text-muted-foreground/50 hover:text-muted-foreground"
          >
            <MoveDiagonal2Icon className="size-3" />
          </div>
        </div>
      ) : null}

      <Button
        aria-label="Toggle note"
        className="pointer-events-auto"
        size="icon-sm"
        variant="glass"
        onClick={() => {
          flushPendingSave();
          setOpen((value) => !value);
        }}
      >
        <NotebookPenIcon className="size-4" />
        {hasNote ? (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-3xs font-semibold text-primary-foreground">
            ✓
          </span>
        ) : null}
      </Button>
    </div>
  );
}
