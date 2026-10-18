/**
 * Fork: the groups of the "Local servers" list while the server setting
 * `previewLocalServerGroups` is on. The upstream list stays the first group. The server sends
 * every other local listener (`ForkLocalListenerList`), and this module groups them for the
 * thread: same worktree, same project, then all others.
 */
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ForkLocalListener,
  type ProjectId,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useProject, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

export type ForkLocalServerGroup = "terminal" | "worktree" | "project" | "other";

type ForkListenerGroup = Exclude<ForkLocalServerGroup, "terminal">;

export interface ForkLocalServerEntry {
  readonly server: PreviewableServer;
  /** Why the entry has no checked page, or null. */
  readonly note: string | null;
}

export interface ForkLocalServerSection {
  readonly group: ForkLocalServerGroup;
  /** Null for the first group, the upstream list. */
  readonly label: string | null;
  readonly entries: ReadonlyArray<ForkLocalServerEntry>;
}

const groupsEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.settingsValueAtom(environmentId))?.previewLocalServerGroups === true,
  ),
);

const localListeners = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-preview:local-listeners",
  tag: WS_METHODS.forkPreviewSubscribeLocalListeners,
  // Dispose at once, so the server stops reading folders and checking servers.
  idleTtlMs: 0,
});

/**
 * The group of each listener for a thread. A port of the upstream list stays there. `folder` is
 * the thread worktree, else the project root, as the server stores it.
 */
export function groupForkListeners(input: {
  readonly shownPorts: ReadonlySet<number>;
  readonly listeners: ReadonlyArray<ForkLocalListener>;
  readonly folder: string | null;
  readonly projectId: ProjectId | null;
}): Readonly<Record<ForkListenerGroup, ReadonlyArray<ForkLocalListener>>> {
  const groups: Record<ForkListenerGroup, ForkLocalListener[]> = {
    worktree: [],
    project: [],
    other: [],
  };
  for (const listener of input.listeners) {
    if (input.shownPorts.has(listener.port)) continue;
    const place = listener.folder;
    if (place !== null && place.projectId === input.projectId) {
      groups[place.folder === input.folder ? "worktree" : "project"].push(listener);
    } else {
      groups.other.push(listener);
    }
  }
  return groups;
}

const CHECK_NOTES: Readonly<Record<ForkLocalListener["check"], string | null>> = {
  page: null,
  noPage: "no page found",
  unchecked: "not checked",
  checking: "checking…",
};

/**
 * The sections of the list. While the setting is off, the only section is the upstream list, so
 * the list is exactly the upstream list.
 */
export function useForkLocalServerSections(input: {
  readonly threadRef: ScopedThreadRef;
  readonly servers: ReadonlyArray<PreviewableServer>;
}): {
  readonly groupsEnabled: boolean;
  readonly sections: ReadonlyArray<ForkLocalServerSection>;
} {
  const { environmentId } = input.threadRef;
  const enabled = useAtomValue(groupsEnabledAtom(environmentId));
  const thread = useThreadShell(input.threadRef);
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const query = useEnvironmentQuery(enabled ? localListeners({ environmentId, input: {} }) : null);
  const terminal: ForkLocalServerSection = {
    group: "terminal",
    label: null,
    entries: input.servers.map((server) => ({ server, note: null })),
  };
  if (!enabled) {
    return { groupsEnabled: false, sections: terminal.entries.length > 0 ? [terminal] : [] };
  }

  const worktreePath = thread?.worktreePath ?? null;
  const groups = groupForkListeners({
    shownPorts: new Set(input.servers.map((server) => server.port)),
    listeners: query.data?.listeners ?? [],
    folder: worktreePath ?? project?.workspaceRoot ?? null,
    projectId: thread?.projectId ?? null,
  });
  const toEntry = (listener: ForkLocalListener): ForkLocalServerEntry => ({
    server: {
      host: listener.host,
      port: listener.port,
      url: resolveDiscoveredServerUrl(environmentId, listener.url),
      requestedUrl: listener.url,
      processName: listener.processName,
      pid: listener.pid,
      terminal: null,
      source: "scanner",
    },
    note: CHECK_NOTES[listener.check],
  });
  const sections: ReadonlyArray<ForkLocalServerSection> = [
    terminal,
    {
      group: "worktree",
      label: worktreePath ? "This worktree" : "This project folder",
      entries: groups.worktree.map(toEntry),
    },
    {
      group: "project",
      label: "Other folders of this project",
      entries: groups.project.map(toEntry),
    },
    { group: "other", label: "All other local servers", entries: groups.other.map(toEntry) },
  ];
  return {
    groupsEnabled: true,
    sections: sections.filter((section) => section.entries.length > 0),
  };
}

/**
 * The empty state text. Upstream promised that every browser-ready localhost server shows up, but
 * it lists only the servers of T3 terminals.
 */
export function forkEmptyDescription(groupsEnabled: boolean): string {
  return groupsEnabled
    ? "Type a URL above, or start a local server. It shows up here."
    : "Type a URL above, or run a dev script in a T3 terminal. Its localhost server shows up here.";
}
