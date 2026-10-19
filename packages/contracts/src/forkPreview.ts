/**
 * Fork: local listeners for the groups of the preview "Local servers" list, while the server
 * setting `previewLocalServerGroups` is on. The upstream list (`DiscoveredLocalServerList`) keeps
 * the servers of T3 terminals. This list holds every other local listener.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DiscoveredLocalServer } from "./preview.ts";

/**
 * The project root or worktree that holds the working folder of the listener process. `folder`
 * is that path as the server stores it, so a client compares it with a thread worktree path or a
 * project root as a plain string.
 */
export const ForkLocalListenerFolder = Schema.Struct({
  projectId: ProjectId,
  folder: TrimmedNonEmptyString,
});
export type ForkLocalListenerFolder = typeof ForkLocalListenerFolder.Type;

export const ForkLocalListener = Schema.Struct({
  host: DiscoveredLocalServer.fields.host,
  port: DiscoveredLocalServer.fields.port,
  url: DiscoveredLocalServer.fields.url,
  processName: DiscoveredLocalServer.fields.processName,
  pid: DiscoveredLocalServer.fields.pid,
  /** Null: outside every project, or the folder is not known. */
  folder: Schema.NullOr(ForkLocalListenerFolder),
  /**
   * The HTTP check of `url`. The server checks only a listener inside a project folder, so a
   * listener outside every project is always `unchecked`. `checking`: the first check runs.
   */
  check: Schema.Literals(["page", "noPage", "unchecked", "checking"]),
  /**
   * The T3 thread whose agent started the process, when the server knows it for certain. Missing
   * from older servers, so it decodes to null.
   */
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type ForkLocalListener = typeof ForkLocalListener.Type;

export const ForkLocalListenerList = Schema.Struct({
  listeners: Schema.Array(ForkLocalListener),
});
export type ForkLocalListenerList = typeof ForkLocalListenerList.Type;
