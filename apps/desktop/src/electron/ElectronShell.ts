import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  remoteSchemeForEditor,
  type SystemSettingsPane,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWebLinkBrowser from "../app/DesktopWebLinkBrowser.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

// Remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`,
// `zed://ssh/<host>/<path>`, `jetbrains://gateway/ssh/environment?h=…`) must
// reach the OS handler; every other non-web scheme stays blocked.
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

// Zed's host sits in the first path segment, so it needs its own userinfo ban.
const ZED_SSH_PATHNAME = /^\/[^/@:]+\/.*$/;

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  (url.protocol === "zed:"
    ? url.host === "ssh" && ZED_SSH_PATHNAME.test(url.pathname)
    : url.protocol === "jetbrains:"
      ? url.host === "gateway" &&
        url.pathname === "/ssh/environment" &&
        (url.searchParams.get("h") ?? "").length > 0
      : url.host === "vscode-remote" &&
        url.pathname.startsWith("/ssh-remote+") &&
        url.pathname.length > "/ssh-remote+".length);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) || isRemoteEditorUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    /** Opens a known System Settings pane by identifier, not by URL. */
    readonly openSystemSettings: (pane: SystemSettingsPane) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openSystemSettings: (pane) =>
    Effect.promise(() =>
      Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[pane]).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.promise(() => Electron.clipboard.writeText(text).catch(() => undefined)),
});

export const layer = Layer.succeed(ElectronShell, make);

/** System-browser actions use the fallback only while PR routing is enabled. */
export const layerWithBrowserRouting = Layer.effect(
  ElectronShell,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const browsers = yield* DesktopWebLinkBrowser.DesktopWebLinkBrowser;

    return ElectronShell.of({
      ...make,
      openExternal: Effect.fn("desktop.shell.openExternal")(
        function* (rawUrl) {
          const externalUrl = parseSafeExternalUrl(rawUrl);
          if (Option.isNone(externalUrl)) return false;
          if (
            environment.platform !== "darwin" ||
            !SAFE_WEB_PROTOCOLS.has(new URL(externalUrl.value).protocol)
          ) {
            return yield* make.openExternal(externalUrl.value);
          }
          const settings = yield* clientSettings.get;
          if (Option.isNone(settings) || !settings.value.desktopChangeRequestLinksEnabled) {
            return yield* make.openExternal(externalUrl.value);
          }
          const fallback = settings.value.desktopLinkFallbackBrowserId;
          if (fallback === null) return false;
          return yield* browsers.open(externalUrl.value, fallback).pipe(Effect.as(true));
        },
        Effect.orElseSucceed(() => false),
      ),
    });
  }),
);
