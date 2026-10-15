import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ConnectionCatalogDocument, Persistence } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import { afterEach, vi } from "vite-plus/test";

import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect(
    "refreshes external changes and keeps the last good catalog after failed refreshes",
    () =>
      Effect.gen(function* () {
        const first = { ...emptyCatalog, disabledEnvironmentIds: [EnvironmentId.make("first")] };
        const second = { ...emptyCatalog, disabledEnvironmentIds: [EnvironmentId.make("second")] };
        const raw = yield* Ref.make(encodeCatalog(first));
        const observed: unknown[] = [];
        const writes: string[] = [];
        const store = yield* ConnectionStorage.makeCatalogStore({
          read: Ref.get(raw).pipe(
            Effect.flatMap((value) =>
              value === "unreadable"
                ? Effect.fail(
                    new ConnectionTransientError({
                      reason: "remote-unavailable",
                      detail: "read failed",
                    }),
                  )
                : Effect.succeed(value),
            ),
          ),
          write: (value) => Effect.sync(() => writes.push(value)),
          changes: Stream.fromIterable([
            encodeCatalog(second),
            "{bad-json",
            "unreadable",
            encodeCatalog(first),
          ]).pipe(
            Stream.mapEffect((value) => Ref.set(raw, value)),
            Stream.rechunk(1),
          ),
        });
        expect(yield* store.read).toEqual(first);
        yield* store.changes!.pipe(
          Stream.runForEach(() =>
            store.read.pipe(Effect.tap((value) => Effect.sync(() => observed.push(value)))),
          ),
        );
        expect(observed).toEqual([second, first]);
        expect(writes).toEqual([]);
        expect(yield* store.read).toEqual(first);
      }),
  );

  it.effect("rereads before saving so a stale cache preserves externally added environments", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: EnvironmentId.make("external"),
        label: "External",
      });
      const raw = yield* Ref.make(encodeCatalog(emptyCatalog));
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Ref.get(raw),
        write: (value) => Ref.set(raw, value),
      });
      yield* store.read;
      yield* Ref.set(raw, encodeCatalog({ ...emptyCatalog, targets: [target] }));
      yield* store.update((catalog) => ({
        ...catalog,
        disabledEnvironmentIds: [target.environmentId],
      }));
      expect(decodeCatalog(yield* Ref.get(raw))).toEqual({
        ...emptyCatalog,
        targets: [target],
        disabledEnvironmentIds: [target.environmentId],
      });
      yield* Ref.set(raw, "{bad-json");
      expect((yield* Effect.flip(store.update((catalog) => catalog)))._tag).toBe(
        "ConnectionTransientError",
      );
      expect(yield* Ref.get(raw)).toBe("{bad-json");
    }),
  );

  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("subscribes before the initial refresh and releases the desktop listener", () =>
    Effect.gen(function* () {
      let listener = () => {};
      let subscribed = false;
      let unsubscribed = false;
      let raw = encodeCatalog(emptyCatalog);
      const updated = { ...emptyCatalog, disabledEnvironmentIds: [EnvironmentId.make("external")] };
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: async () => {
            expect(subscribed).toBe(true);
            return raw;
          },
          setConnectionCatalog: async () => true,
          onConnectionCatalogChanged: (callback: () => void) => {
            listener = callback;
            subscribed = true;
            return () => {
              unsubscribed = true;
            };
          },
        },
      });
      yield* Effect.gen(function* () {
        const backend = ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));
        const store = yield* ConnectionStorage.makeCatalogStore(backend);
        const pull = yield* Stream.toPull(store.changes!);
        yield* pull;
        expect(yield* store.read).toEqual(emptyCatalog);
        raw = encodeCatalog(updated);
        listener();
        yield* pull;
        expect(yield* store.read).toEqual(updated);
      }).pipe(Effect.scoped);
      expect(unsubscribed).toBe(true);
    }),
  );

  it.effect("reports a closed IndexedDB connection as a typed read and write failure", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const database = {
        transaction: () => {
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      } as unknown as IDBDatabase;
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(database));

      const readError = yield* Effect.flip(backend.read);
      const writeError = yield* Effect.flip(backend.write("{}"));

      expect(readError).toBeInstanceOf(ConnectionTransientError);
      expect(readError.message).toContain("The database connection is closing.");
      expect(writeError).toBeInstanceOf(ConnectionTransientError);
    }),
  );

  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );

  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("environment cache removal", () => {
  it.effect("fails both removal operations when IndexedDB aborts their commits", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      vi.stubGlobal("IDBKeyRange", { bound: () => ({}) });
      const database = Object.assign(new EventTarget(), {
        transaction: () => {
          const transaction = Object.assign(new EventTarget(), {
            error: new DOMException("Commit aborted", "AbortError"),
            objectStore: () => ({
              delete: () => queueMicrotask(() => transaction.dispatchEvent(new Event("abort"))),
              openCursor: () => {
                queueMicrotask(() => transaction.dispatchEvent(new Event("abort")));
                return new EventTarget();
              },
            }),
          });
          return transaction;
        },
        close: vi.fn(),
      }) as unknown as IDBDatabase;
      const openRequest = Object.assign(new EventTarget(), { result: database, error: null });
      vi.stubGlobal("indexedDB", {
        open: () => {
          queueMicrotask(() => openRequest.dispatchEvent(new Event("success")));
          return openRequest;
        },
      });

      const [threadError, refsError] = yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        return [
          yield* Effect.flip(
            cache.removeThread(EnvironmentId.make("env"), ThreadId.make("thread")),
          ),
          yield* Effect.flip(cache.clearVcsRefs(EnvironmentId.make("env"))),
        ] as const;
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(threadError.message).toContain("Commit aborted");
      expect(refsError.message).toContain("Commit aborted");
      expect(database.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reports an initial open failure from the cache operation", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const open = vi.fn(() => {
        throw new DOMException("Storage is unavailable", "InvalidStateError");
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        expect(open).not.toHaveBeenCalled();
        const error = yield* Effect.flip(
          cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread")),
        );
        expect(error.message).toContain("Storage is unavailable");
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(open).toHaveBeenCalledOnce();
    }),
  );

  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});
