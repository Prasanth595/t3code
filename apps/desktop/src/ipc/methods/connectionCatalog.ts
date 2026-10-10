import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as ElectronRequestHeaders from "../../electron/ElectronRequestHeaders.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// The catalog holds the per-origin request headers, so every read or write
// refreshes the headers the main process adds to requests.
const applyRequestHeaders = (catalog: string | null) =>
  Effect.gen(function* () {
    const skipped = ElectronRequestHeaders.applyConnectionCatalog(catalog);
    if (skipped.length > 0) {
      yield* Effect.logWarning("Skipped invalid request headers in the connection catalog.", {
        origins: skipped,
      });
    }
  });

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    const catalog = Option.getOrNull(yield* store.get);
    yield* applyRequestHeaders(catalog);
    return catalog;
  }),
});

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog) {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    const stored = yield* store.set(catalog);
    // Headers that were not stored must not apply either.
    if (stored) yield* applyRequestHeaders(catalog);
    return stored;
  }),
});

export const clearConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.connectionCatalog.clear")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    yield* store.clear;
    yield* applyRequestHeaders(null);
  }),
});

export const isCloudflareAccessChallenged = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.IS_CLOUDFLARE_ACCESS_CHALLENGED_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.isCloudflareAccessChallenged")(function* (url) {
    return yield* Effect.sync(() => ElectronRequestHeaders.isCloudflareAccessChallenged(url));
  }),
});
