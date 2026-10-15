import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";

export const installConnectionCatalogEventForwarding = Effect.fn(
  "desktop.ipc.connectionCatalog.installEventForwarding",
)(function* () {
  const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const window = yield* ElectronWindow.ElectronWindow;
  yield* store.changes.pipe(
    Stream.runForEach(() => window.sendAll(IpcChannels.CONNECTION_CATALOG_CHANGED_CHANNEL)),
    Effect.forkScoped,
  );
});

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return Option.getOrNull(yield* store.get);
  }),
});

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog) {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return yield* store.set(catalog);
  }),
});

export const clearConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.connectionCatalog.clear")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    yield* store.clear;
  }),
});
