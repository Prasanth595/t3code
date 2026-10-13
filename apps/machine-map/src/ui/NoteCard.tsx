import { useState, type KeyboardEvent, type PointerEvent } from "react";
import type { MapNote, NoteColor } from "@t3tools/contracts/machineMap";

import type { Point } from "./layout.ts";

export const NOTE_COLORS: ReadonlyArray<NoteColor> = ["yellow", "pink", "blue", "green"];
const MAX_TEXT = 500;

/** One of four tilts per note (CSS `tilt-0` to `tilt-3`), the same on every page. */
const tiltClass = (id: string): string => {
  let sum = 0;
  for (const char of id) sum += char.charCodeAt(0);
  return `tilt-${sum % 4}`;
};

/** MM-1109: a sticky note. A tap edits it in place; a drag moves it (MapView owns the drag). */
export function NoteCard(props: {
  note: MapNote;
  at: Point;
  editing: boolean;
  readOnly: boolean;
  /** False for a note that is not saved yet: it has nothing to delete. */
  saved: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onEdit: () => void;
  onSave: (text: string, color: NoteColor) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { note, at, editing } = props;
  const style = { left: at.x, top: at.y };
  if (editing) return <NoteEditor {...props} style={style} />;
  return (
    <div
      role={props.readOnly ? undefined : "button"}
      tabIndex={props.readOnly ? undefined : 0}
      aria-label={props.readOnly ? undefined : `Note: ${note.text}. Edit`}
      data-note-id={note.id}
      data-size-key={`note:${note.id}`}
      className={`note note-${note.color} ${tiltClass(note.id)}${props.readOnly ? " readonly" : ""}`}
      style={style}
      onPointerDown={props.readOnly ? undefined : props.onPointerDown}
      onClick={props.readOnly ? undefined : props.onEdit}
      onKeyDown={
        props.readOnly
          ? undefined
          : (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onEdit();
              }
            }
      }
    >
      {note.text}
    </div>
  );
}

function NoteEditor(props: {
  note: MapNote;
  saved: boolean;
  style: { left: number; top: number };
  onSave: (text: string, color: NoteColor) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(props.note.text);
  const [color, setColor] = useState(props.note.color);
  const trimmed = text.trim();
  const save = () => (trimmed ? props.onSave(trimmed, color) : props.onCancel());
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };
  return (
    <div
      data-note-id={props.note.id}
      className={`note note-${color} editing`}
      style={props.style}
      onKeyDown={onKey}
    >
      <textarea
        aria-label="Note text"
        value={text}
        maxLength={MAX_TEXT}
        placeholder="Write a note"
        autoFocus
        rows={3}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="note-colors" role="group" aria-label="Colour">
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch note-${c}`}
            aria-label={c}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="note-actions">
        {props.saved && (
          <button type="button" className="btn small danger" onClick={props.onDelete}>
            Delete
          </button>
        )}
        <button type="button" className="btn small" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={save}>
          {trimmed ? "Done" : "Close"}
        </button>
      </div>
    </div>
  );
}
