// @effect-diagnostics globalTimers:off -- The helper timeout runs at a worker callback boundary outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node worker.

import * as NodeWorkerThreads from "node:worker_threads";

import type * as Electron from "electron";

const FOCUS_TIMEOUT_MS = 1_000;

export type WindowsForegroundFocusTarget = {
  readonly windowId: number;
  readonly processId: number;
  readonly title: string;
  readonly bounds: Electron.Rectangle;
  readonly contentBounds: Electron.Rectangle;
};

export type WindowsForegroundFocusThread = {
  readonly prepare: (target: WindowsForegroundFocusTarget) => Promise<boolean>;
  readonly focus: (target: WindowsForegroundFocusTarget) => Promise<boolean>;
  readonly close: () => void;
};

type FocusRequest = {
  readonly type: "prepare" | "focus";
  readonly requestId: number;
  readonly target: WindowsForegroundFocusTarget;
};

type FocusResult = {
  readonly type: "result";
  readonly requestId: number;
  readonly focused: boolean;
};

const unavailableThread = (): WindowsForegroundFocusThread => ({
  prepare: async () => false,
  focus: async () => false,
  close: () => undefined,
});

export function startWindowsForegroundFocusThread(
  workerPath: string,
): WindowsForegroundFocusThread {
  let worker: NodeWorkerThreads.Worker | undefined;
  let ready = false;
  let closed = false;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    {
      readonly request: FocusRequest;
      readonly key: string;
      readonly resolvers: Array<(focused: boolean) => void>;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();
  // Concurrent duplicate requests (the capture-reveal path issues prepare
  // then focus for the same window, and retries focus on failure) ride along
  // on one worker round-trip instead of stacking timers and focus fights.
  const inflightByKey = new Map<string, number>();

  const finish = (requestId: number, focused: boolean) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    if (inflightByKey.get(request.key) === requestId) inflightByKey.delete(request.key);
    clearTimeout(request.timeout);
    for (const resolve of request.resolvers) resolve(focused);
  };
  const send = (request: FocusRequest, targetWorker: NodeWorkerThreads.Worker) => {
    if (!ready || closed || worker !== targetWorker) return;
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      targetWorker.postMessage(request);
    } catch {
      finish(request.requestId, false);
    }
  };
  const start = (): boolean => {
    if (closed) return false;
    let nextWorker: NodeWorkerThreads.Worker;
    try {
      nextWorker = new NodeWorkerThreads.Worker(workerPath);
      nextWorker.unref();
    } catch {
      return false;
    }

    worker = nextWorker;
    ready = false;
    const reset = () => {
      if (worker !== nextWorker) return;
      worker = undefined;
      ready = false;
      for (const requestId of pending.keys()) finish(requestId, false);
    };
    nextWorker.on("message", (rawMessage) => {
      if (worker !== nextWorker) return;
      if (rawMessage === "ready") {
        ready = true;
        for (const request of pending.values()) send(request.request, nextWorker);
        return;
      }
      const message = rawMessage as FocusResult;
      if (message.type === "result") finish(message.requestId, message.focused);
    });
    nextWorker.once("error", reset);
    nextWorker.once("exit", reset);
    return true;
  };

  if (!start()) return unavailableThread();

  // A timed-out helper is hung: terminate it but restart lazily on the next
  // request instead of eagerly respawning a native module nobody may use.
  const suspendWorker = (timedOutWorker: NodeWorkerThreads.Worker | undefined) => {
    if (!timedOutWorker || worker !== timedOutWorker) return;
    worker = undefined;
    ready = false;
    void timedOutWorker.terminate();
  };
  const request = (type: FocusRequest["type"], target: WindowsForegroundFocusTarget) =>
    new Promise<boolean>((resolve) => {
      if (closed) {
        resolve(false);
        return;
      }
      const key = `${type}:${target.windowId}`;
      const existingId = inflightByKey.get(key);
      const existing = existingId === undefined ? undefined : pending.get(existingId);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      if (!worker && !start()) {
        resolve(false);
        return;
      }
      const requestId = nextRequestId++;
      const focusRequest = { type, requestId, target } satisfies FocusRequest;
      const requestWorker = worker!;
      const timeout = setTimeout(() => {
        finish(requestId, false);
        suspendWorker(requestWorker);
      }, FOCUS_TIMEOUT_MS);
      timeout.unref();
      pending.set(requestId, { request: focusRequest, key, resolvers: [resolve], timeout });
      inflightByKey.set(key, requestId);
      send(focusRequest, requestWorker);
    });

  return {
    prepare: (target) => request("prepare", target),
    focus: (target) => request("focus", target),
    close: () => {
      if (closed) return;
      closed = true;
      const activeWorker = worker;
      worker = undefined;
      ready = false;
      for (const requestId of pending.keys()) finish(requestId, false);
      if (activeWorker) void activeWorker.terminate();
    },
  };
}
