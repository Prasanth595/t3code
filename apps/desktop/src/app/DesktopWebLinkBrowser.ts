import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { isWebLink } from "./DesktopWebLinks.ts";

// Resolve installed bundles through Launch Services instead of trusting leftover
// browser profile directories. A browser allowlist excludes every T3 app variant.
const BROWSER_BUNDLE_IDS = [
  "com.apple.Safari",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "org.chromium.Chromium",
  "org.mozilla.firefox",
  "org.mozilla.nightly",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "com.vivaldi.Vivaldi",
  "com.operasoftware.Opera",
  "company.thebrowser.Browser",
  "com.kagi.kagimacOS",
  "app.zen-browser.zen",
  "net.imput.helium",
];

// AppKit queries do not send Apple Events or require Automation permission.
const INSTALLED_BROWSERS_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  return JSON.stringify(JSON.parse(argv[0]).reduce(function(found, id) {
    var url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
    if (!url || url.isNil() || !$.NSFileManager.defaultManager.fileExistsAtPath(url.path)) return found;
    var bundle = $.NSBundle.bundleWithURL(url);
    if (!bundle || bundle.isNil()) return found;
    var info = ObjC.deepUnwrap(bundle.infoDictionary);
    if (info.CFBundleIdentifier !== id) return found;
    var schemes = (info.CFBundleURLTypes || []).reduce(function(all, type) {
      return all.concat(type.CFBundleURLSchemes || []);
    }, []);
    if (schemes.some(function(scheme) { return /^t3code/i.test(scheme); })) return found;
    found.push({ id: id, name: info.CFBundleDisplayName || info.CFBundleName || id });
    return found;
  }, []));
}
`;

export const WebLinkBrowser = Schema.Struct({ id: Schema.String, name: Schema.String });
const decodeBrowsers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(WebLinkBrowser)),
);
const encodeBrowserIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class DesktopWebLinkBrowserError extends Schema.TaggedError<DesktopWebLinkBrowserError>()(
  "DesktopWebLinkBrowserError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class DesktopWebLinkBrowser extends Context.Service<
  DesktopWebLinkBrowser,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<typeof WebLinkBrowser.Type>,
      DesktopWebLinkBrowserError
    >;
    readonly open: (
      url: string,
      browserId: string,
    ) => Effect.Effect<void, DesktopWebLinkBrowserError>;
    readonly openSettings: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopWebLinkBrowser") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = (executable: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            shell: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          }),
        );
        const [output, exitCode] = yield* Effect.all(
          [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: 2 },
        );
        if (exitCode !== 0) {
          return yield* new DesktopWebLinkBrowserError({
            message: "macOS could not open the browser.",
          });
        }
        return output;
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) =>
          new DesktopWebLinkBrowserError({ message: "macOS browser command failed.", cause }),
      ),
    );

  const list =
    environment.platform === "darwin"
      ? run("/usr/bin/osascript", [
          "-l",
          "JavaScript",
          "-e",
          INSTALLED_BROWSERS_SCRIPT,
          encodeBrowserIds(BROWSER_BUNDLE_IDS.filter((id) => id !== environment.appUserModelId)),
        ]).pipe(
          Effect.flatMap(decodeBrowsers),
          Effect.mapError(
            (cause) =>
              new DesktopWebLinkBrowserError({
                message: "Could not find installed browsers.",
                cause,
              }),
          ),
        )
      : Effect.succeed([]);

  return DesktopWebLinkBrowser.of({
    list,
    open: Effect.fn("desktop.webLinkBrowser.open")(function* (url, browserId) {
      if (!isWebLink(url)) {
        return yield* new DesktopWebLinkBrowserError({
          message: "Only http and https links can open in a browser.",
        });
      }
      if (!BROWSER_BUNDLE_IDS.includes(browserId) || browserId === environment.appUserModelId) {
        return yield* new DesktopWebLinkBrowserError({
          message: "Choose an installed browser other than T3 Code.",
        });
      }
      const browsers = yield* list;
      if (!browsers.some((browser) => browser.id === browserId)) {
        return yield* new DesktopWebLinkBrowserError({
          message: "Choose an installed browser other than T3 Code.",
        });
      }
      // An explicit bundle ID bypasses the system default and prevents routing loops.
      yield* run("/usr/bin/open", ["-b", browserId, new URL(url).href]);
    }),
    openSettings:
      environment.platform === "darwin"
        ? run("/usr/bin/open", [
            "x-apple.systempreferences:com.apple.Desktop-Settings.extension?DefaultWebBrowser",
          ]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        : Effect.succeed(false),
  });
});

export const layer = Layer.effect(DesktopWebLinkBrowser, make);
