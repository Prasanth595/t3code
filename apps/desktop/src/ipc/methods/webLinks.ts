import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWebLinks from "../../app/DesktopWebLinks.ts";
import * as DesktopWebLinkBrowser from "../../app/DesktopWebLinkBrowser.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WEB_LINK_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.webLinks.setReady")(function* (ready) {
    const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
    yield* webLinks.setRendererReady(ready);
  }),
});

export const listBrowsers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WEB_LINK_BROWSERS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopWebLinkBrowser.WebLinkBrowser),
  handler: Effect.fn("desktop.ipc.webLinks.listBrowsers")(function* () {
    const browsers = yield* DesktopWebLinkBrowser.DesktopWebLinkBrowser;
    return yield* browsers.list;
  }),
});

export const openInBrowser = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WEB_LINK_BROWSER_OPEN_CHANNEL,
  payload: Schema.Struct({ url: Schema.String, browserId: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.webLinks.openInBrowser")(function* ({ url, browserId }) {
    const browsers = yield* DesktopWebLinkBrowser.DesktopWebLinkBrowser;
    yield* browsers.open(url, browserId);
  }),
});

export const openSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WEB_LINK_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.webLinks.openSettings")(function* () {
    const browsers = yield* DesktopWebLinkBrowser.DesktopWebLinkBrowser;
    return yield* browsers.openSettings;
  }),
});
