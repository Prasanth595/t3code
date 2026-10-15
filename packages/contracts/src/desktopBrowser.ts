import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The desktop app renders browser tabs for the server it launched, and the
 * server drives them with the same engine as its headless tabs. Messages
 * travel as newline-delimited JSON over two bootstrap file descriptors, so
 * only that one server can reach the desktop's pages; nothing listens on a port.
 *
 * Each tab carries one CDP connection, multiplexed by `tabId`. CDP frames pass
 * through untouched; the desktop answers them with `CdpRelay`.
 */

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

/** Desktop -> server. */
export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

/** Server -> desktop. */
export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** The server stopped driving this tab, so the relay can drop its sessions. */
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
