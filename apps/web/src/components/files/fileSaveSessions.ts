import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { isHostPath } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "~/state/session";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getPersistedProjectFileQueryData,
  getProjectFileQueryAtom,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

export interface FileSaveTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type FilePendingListener = (relativePath: string, pending: boolean) => void;

export interface FileSaveSessionDeps {
  readonly debounceMs: number;
  readonly canPersist: (target: FileSaveTarget) => boolean;
  /** Calls `onWritable` each time the target environment regains write access. */
  readonly subscribeWritable: (target: FileSaveTarget, onWritable: () => void) => () => void;
  readonly persist: (
    target: FileSaveTarget,
    contents: string,
    expectedContents: string | undefined,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  /** The contents a save must replace, or undefined when saves to this file are unconditional. */
  readonly readBase: (target: FileSaveTarget) => string | undefined;
  readonly confirm: (target: FileSaveTarget, contents: string) => boolean;
  readonly readUnsaved: (target: FileSaveTarget) => string | null;
}

interface FileSaveSession {
  readonly coordinator: FileSaveCoordinator;
  /** Lease count per listener; surfaces may share one listener. */
  readonly listeners: Map<FilePendingListener, number>;
  readonly unsubscribeWritable: () => void;
  leases: number;
  /** The last release flushed, and the session stays open until that settles. */
  flushingOnRelease: boolean;
}

/**
 * One save session, so one ordered write queue, per file. A released session
 * stays open until its flush settles, so a surface rejoining meanwhile reuses
 * it instead of racing the flush. A session that cannot write closes at once,
 * and the next one, or regained write access, resumes the unsaved draft.
 */
export function createFileSaveSessions(deps: FileSaveSessionDeps) {
  const sessions = new Map<string, FileSaveSession>();
  // The contents a draft was started from, pinned at its first edit: the file
  // query refetches after every workspace mutation, so it can already hold
  // someone else's newer contents by the time the draft saves.
  const bases = new Map<string, string | undefined>();

  const pinBase = (key: string, target: FileSaveTarget) => {
    if (!bases.has(key)) bases.set(key, deps.readBase(target));
  };

  const recover = (target: FileSaveTarget, coordinator: FileSaveCoordinator) => {
    if (!deps.canPersist(target)) return;
    const unsaved = deps.readUnsaved(target);
    if (unsaved === null) return;
    pinBase(fileSaveKey(target), target);
    coordinator.change(unsaved);
  };

  const create = (key: string, target: FileSaveTarget): FileSaveSession => {
    const listeners = new Map<FilePendingListener, number>();
    const coordinator: FileSaveCoordinator = new FileSaveCoordinator({
      debounceMs: deps.debounceMs,
      canPersist: () => deps.canPersist(target),
      // The last surface's listeners outlive it: a flush that settles after
      // the session is released still has to clear the pending marker.
      onPendingChange: (pending) => {
        for (const listener of listeners.keys()) listener(target.relativePath, pending);
      },
      persist: async (contents) => {
        const base = bases.get(key);
        const result = await deps.persist(target, contents, base);
        if (result._tag === "Success" && base !== undefined && bases.has(key)) {
          bases.set(key, contents);
        }
        return result;
      },
      onConfirmed: (contents) => deps.confirm(target, contents),
      onSettled: () => {
        if (!session.flushingOnRelease) return;
        session.flushingOnRelease = false;
        if (session.leases === 0) {
          if (sessions.get(key) === session) sessions.delete(key);
          if (coordinator.unconfirmedContents === null) bases.delete(key);
          session.unsubscribeWritable();
        } else if (coordinator.unconfirmedContents !== null) {
          // A surface rejoined while the release flush failed; retry it once.
          recover(target, coordinator);
        }
      },
    });
    const unsubscribeWritable = deps.subscribeWritable(target, () => recover(target, coordinator));
    const session: FileSaveSession = {
      coordinator,
      listeners,
      unsubscribeWritable,
      leases: 0,
      flushingOnRelease: false,
    };
    return session;
  };

  const acquire = (target: FileSaveTarget, onPendingChange: FilePendingListener): (() => void) => {
    const key = fileSaveKey(target);
    const existing = sessions.get(key);
    const session = existing ?? create(key, target);
    sessions.set(key, session);
    session.leases += 1;
    session.listeners.set(onPendingChange, (session.listeners.get(onPendingChange) ?? 0) + 1);
    if (!existing) recover(target, session.coordinator);
    else if (session.coordinator.unconfirmedContents !== null) {
      onPendingChange(target.relativePath, true);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.leases -= 1;
      if (session.leases > 0) {
        const count = (session.listeners.get(onPendingChange) ?? 1) - 1;
        if (count > 0) session.listeners.set(onPendingChange, count);
        else session.listeners.delete(onPendingChange);
        return;
      }
      session.flushingOnRelease = true;
      session.coordinator.flush();
    };
  };

  return {
    /** Holds the file's session open until the returned release runs. */
    acquire,
    /** Edits for a file nobody holds open are dropped, so retired editors stay inert. */
    change(target: FileSaveTarget, contents: string): void {
      const key = fileSaveKey(target);
      const session = sessions.get(key);
      if (!session || session.leases === 0) return;
      pinBase(key, target);
      session.coordinator.change(contents);
    },
    /** Drops the unsaved draft; the next edit starts from the file as read then. */
    discard(target: FileSaveTarget): void {
      const key = fileSaveKey(target);
      bases.delete(key);
      sessions.get(key)?.coordinator.discard();
    },
  };
}

function fileSaveKey({ environmentId, cwd, relativePath }: FileSaveTarget): string {
  return `${environmentId}\u0000${cwd}\u0000${relativePath}`;
}

const fileSaveSessions = createFileSaveSessions({
  debounceMs: 500,
  canPersist: ({ environmentId }) => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
  subscribeWritable: ({ environmentId }, onWritable) => {
    let writable = readEnvironmentScope(environmentId, AuthFilesystemWriteScope);
    return appAtomRegistry.subscribe(
      environmentSession.sessionStateAtom(environmentId),
      (state) => {
        const next = sessionHasScope(state, AuthFilesystemWriteScope);
        if (next && !writable) onWritable();
        writable = next;
      },
    );
  },
  persist: async (target, contents, expectedContents) => {
    const { environmentId, cwd, relativePath } = target;
    const result = await runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, {
      environmentId,
      input: {
        cwd,
        relativePath,
        contents,
        ...(expectedContents === undefined ? {} : { expectedContents }),
      },
    });
    if (result._tag !== "Success" || result.value.conflict !== true) return result;
    showSaveConflict(target);
    return AsyncResult.failure(Cause.fail(new Error(`${relativePath} changed on disk.`)));
  },
  readBase: ({ environmentId, cwd, relativePath }) => {
    if (!isHostPath(relativePath)) return undefined;
    const file = getPersistedProjectFileQueryData(environmentId, cwd, relativePath);
    return file?.supportsConditionalWrite && !file.truncated && file.exists !== false
      ? file.contents
      : undefined;
  },
  confirm: ({ environmentId, cwd, relativePath }, contents) =>
    confirmProjectFileQueryData(environmentId, cwd, relativePath, contents),
  readUnsaved: ({ environmentId, cwd, relativePath }) =>
    getUnsavedProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? null,
});

const conflictToasts = new Map<string, ReturnType<typeof toastManager.add>>();

function showSaveConflict(target: FileSaveTarget): void {
  const key = fileSaveKey(target);
  const previous = conflictToasts.get(key);
  if (previous !== undefined) toastManager.close(previous);
  const id = toastManager.add({
    type: "error",
    title: `${target.relativePath.split(/[\\/]/).pop()} changed on disk`,
    description: "Your edits were not saved. Reload to see the current file and discard them.",
    actionProps: {
      children: "Reload",
      onClick: () => {
        toastManager.close(id);
        conflictToasts.delete(key);
        fileSaveSessions.discard(target);
        clearProjectFileQueryData(target.environmentId, target.cwd, target.relativePath);
        appAtomRegistry.refresh(
          getProjectFileQueryAtom(target.environmentId, target.cwd, target.relativePath),
        );
      },
    },
  });
  conflictToasts.set(key, id);
}

/** Holds the file's save session while the surface is mounted; the last surface to leave flushes. */
export function useFileSaveSession(
  { environmentId, cwd, relativePath }: FileSaveTarget,
  onPendingChange: FilePendingListener,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the lease is a mount-scoped external resource; React runs every unmount cleanup before mount setups, so a surface switch flushes before the next surface recovers.
  useEffect(
    () => fileSaveSessions.acquire({ environmentId, cwd, relativePath }, onPendingChange),
    [environmentId, cwd, relativePath, onPendingChange],
  );
}

export function changeFileSaveSession(target: FileSaveTarget, contents: string): void {
  fileSaveSessions.change(target, contents);
}
