import type { GhosttyRow, GhosttyTerminalCore } from "./core";

const MAX_ANNOUNCED_LINES = 20;
const MAX_ANNOUNCED_CHARACTERS = 4_096;
const ANNOUNCE_DELAY_MS = 100;
const TOO_MUCH_OUTPUT = "\nToo much output to announce, read the terminal rows instead.";

/** A row's text as the canvas shows it, with concealed cells blanked. */
export function accessibleRowText(row: GhosttyRow): string {
  if (!row.cells.some((cell) => cell.invisible)) return row.text;
  return row.cells
    .map((cell) => (cell.invisible ? " " : cell.text || " "))
    .join("")
    .trimEnd();
}

function collapseTerminalOverwrites(text: string): string {
  return text
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").findLast(Boolean) ?? "")
    .join("\n");
}

export class TerminalAnnouncer {
  readonly element: HTMLDivElement;
  // Keep only sequence boundaries, never the contents of an unfinished control string.
  private state: "text" | "escape" | "escapeIntermediate" | "csi" | "osc" | "string" = "text";
  private buffer = "";
  private echo = "";
  private lines = 0;
  private characters = 0;
  private capped = false;
  private timer: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "sr-only";
    this.element.setAttribute("aria-live", "polite");
  }

  typed(data: string): void {
    this.element.textContent = "";
    this.lines = 0;
    this.characters = 0;
    this.capped = false;
    // Control keys produce output the screen reader has not already spoken.
    // eslint-disable-next-line no-control-regex -- Distinguish committed text from encoded keys.
    this.echo = /^[^\x00-\x1f\x7f-\x9f]+$/.test(data)
      ? (this.echo + data).slice(-MAX_ANNOUNCED_CHARACTERS)
      : "";
  }

  write(data: string, core: GhosttyTerminalCore, announce: boolean): void {
    if (!announce || this.capped) {
      core.write(data);
      this.scan(data);
      return;
    }
    let written = 0;
    this.scan(data, (start, end) => {
      if (this.capped) return;
      if (start > written) core.write(data.slice(written, start));
      // Let Ghostty apply controls first, including saved/restored cursor styles.
      const concealed = core.isConcealing();
      const text = data.slice(start, end);
      core.write(text);
      written = end;
      if (!concealed) this.output(text);
    });
    if (written < data.length) core.write(data.slice(written));
  }

  /** The core was reset and replayed without announcing it. */
  replay(data: string): void {
    this.reset();
    this.state = "text";
    this.scan(data);
  }

  /** Blur/hide cancel speech while preserving the core's unfinished sequence boundaries. */
  reset(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.element.textContent = "";
    this.buffer = "";
    this.echo = "";
    this.lines = 0;
    this.characters = 0;
    this.capped = false;
  }

  private output(text: string): void {
    for (const char of text) {
      // Redrawing a prompt before the echo must not consume the queued input.
      if (this.echo.startsWith(char)) {
        this.echo = this.echo.slice(char.length);
        continue;
      }
      if (
        this.characters + char.length > MAX_ANNOUNCED_CHARACTERS ||
        this.buffer.length + char.length > MAX_ANNOUNCED_CHARACTERS
      ) {
        this.cap();
        break;
      }
      this.buffer += char;
      this.characters += char.length;
      if (char === "\n" && ++this.lines >= MAX_ANNOUNCED_LINES) {
        this.cap();
        break;
      }
    }
    if (this.buffer.length > 0 && this.timer === null) {
      // Clear for the whole batch delay so identical successive batches are spoken again.
      this.element.textContent = "";
      this.timer = window.setTimeout(this.flush, ANNOUNCE_DELAY_MS);
    }
  }

  private cap(): void {
    this.capped = true;
    this.buffer = this.buffer.slice(0, MAX_ANNOUNCED_CHARACTERS) + TOO_MUCH_OUTPUT;
  }

  private scan(data: string, onText?: (start: number, end: number) => void): void {
    let start = -1;
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (
        this.state === "text" &&
        (code === 0x09 ||
          code === 0x0a ||
          code === 0x0d ||
          (code >= 0x20 && (code < 0x7f || code >= 0xa0)))
      ) {
        if (start < 0) start = index;
        continue;
      }
      if (start >= 0) {
        onText?.(start, index);
        start = -1;
      }
      if (code === 0x18 || code === 0x1a) {
        this.state = "text";
      } else if (code === 0x1b) {
        this.state = "escape";
      } else if (this.state === "osc" || this.state === "string") {
        if (this.state === "osc" && code === 0x07) this.state = "text";
      } else if (this.state === "escape") {
        if (code >= 0x20 && code <= 0x2f) this.state = "escapeIntermediate";
        else if (code === 0x5b) this.state = "csi";
        else if (
          code === 0x5d ||
          code === 0x50 ||
          code === 0x58 ||
          code === 0x5e ||
          code === 0x5f
        ) {
          this.state = code === 0x5d ? "osc" : "string";
        } else if (code >= 0x30 && code <= 0x7e) this.state = "text";
      } else if (this.state === "escapeIntermediate" && code >= 0x30 && code <= 0x7e) {
        this.state = "text";
      } else if (this.state === "csi" && code >= 0x40 && code <= 0x7e) {
        this.state = "text";
      }
    }
    if (start >= 0) onText?.(start, data.length);
  }

  private readonly flush = () => {
    this.timer = null;
    const text = collapseTerminalOverwrites(this.buffer);
    this.buffer = "";
    if (text.trim().length > 0) this.element.textContent = text;
  };
}
