import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn<() => string>>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
    }
  >(),
}));

const { fromWebContents } = vi.hoisted(() => ({
  fromWebContents: vi.fn<(webContents: unknown) => unknown>(() => null),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents },
  session: {
    fromPartition,
  },
}));

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as BrowserSession from "./BrowserSession.ts";

const { showMessageBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn<
    (options: Electron.MessageBoxOptions, owner?: Electron.BrowserWindow) => number
  >(() => 1),
}));
const layerDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.die("unused"),
  pickFiles: () => Effect.die("unused"),
  showMessageBox: (options, owner) =>
    Effect.sync(() => ({ response: showMessageBox(options, owner), checkboxChecked: false })),
  showErrorBox: () => Effect.void,
});
const layer = BrowserSession.layer.pipe(
  Layer.provide(Layer.merge(NodeServices.layer, layerDialog)),
);

/** Exercise the native media callbacks with an embedded page and a controllable tab. */
const mediaSession = (scope = "scope-a") =>
  Effect.gen(function* () {
    const browserSessions = yield* BrowserSession.BrowserSession;
    const partition = yield* browserSessions.getPartition(scope);
    yield* browserSessions.getSession(scope);
    const browserSession = sessions.get(partition);
    assert.isDefined(browserSession);
    const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
    const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
    assert.isFunction(requestHandler);
    assert.isFunction(checkHandler);
    const host = { isDestroyed: () => false };
    const guest = {
      getURL: vi.fn(() => "https://portal.example/certification"),
      isDestroyed: vi.fn(() => false),
      hostWebContents: host,
    };
    const request = (
      details: Omit<Electron.MediaAccessPermissionRequest, "mediaTypes"> & {
        mediaTypes?: string[];
      } = {
        requestingUrl: "https://exam.example/camera-check",
        isMainFrame: false,
        mediaTypes: ["video"],
      },
    ) =>
      Effect.callback<boolean>((resume) => {
        requestHandler(
          guest,
          "media",
          (granted: boolean) => resume(Effect.succeed(granted)),
          details,
        );
      });
    const check = (origin = "https://exam.example", mediaType = "video") =>
      checkHandler(guest, "media", origin, { isMainFrame: false, mediaType });
    return { browserSessions, partition, guest, request, check };
  });

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    showMessageBox.mockReset();
    fromWebContents.mockReset();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setUserAgent: vi.fn(),
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:t3code-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps scopes that differ only by a lone surrogate in separate partitions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      // TextEncoder folds a lone surrogate to U+FFFD, so without escaping these
      // two supported ids would hash to one partition and share every cookie.
      const loneSurrogate = yield* browserSessions.getPartition("p\ud800");
      const replacementChar = yield* browserSessions.getPartition("p\ufffd");
      assert.notStrictEqual(loneSurrogate, replacementChar);

      // The escape can't be forged with a literal backslash either.
      const literal = yield* browserSessions.getPartition("p\\ud800");
      assert.notStrictEqual(literal, loneSurrogate);

      // And a well-formed scope still lands on its historical partition.
      assert.strictEqual(
        yield* browserSessions.getPartition("scope-a"),
        "persist:t3code-preview-f051bb2c68cb7b2fe969",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps legacy defaults disjoint from nondefault profile partitions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      // These share the same scope string: default environment `a::b`, and
      // environment `a` with nondefault profile `b`.
      const legacyDefault = yield* browserSessions.getPartition("a::b");
      const nondefaultProfile = yield* browserSessions.getPartition("a::b", true, "profile");

      assert.strictEqual(legacyDefault, "persist:t3code-preview-78f0be89237d77f7a70e");
      assert.strictEqual(nondefaultProfile, "persist:t3code-preview-profile-78f0be89237d77f7a70e");
      assert.notStrictEqual(nondefaultProfile, legacyDefault);
      assert.isTrue(browserSessions.isPartition(legacyDefault));
      assert.isTrue(browserSessions.isPartition(nondefaultProfile));
    }).pipe(Effect.provide(layer)),
  );

  // A rewritten session UA — any variant, even ones that keep the Electron
  // token — makes Cloudflare Turnstile loop with error 600010 (#5002), so
  // the guest must end up with Electron's native User-Agent. The mock applies
  // setUserAgent calls, so this fails on any reintroduced rewrite while still
  // permitting a harmless re-set of the unchanged native string.
  it.effect("keeps the guest's effective User-Agent equal to Electron's native one", () =>
    Effect.gen(function* () {
      // Electron's real UA shape: app token, then Chrome, then Electron, then
      // Safari — the token order and casing matter to any strip regex.
      const nativeUserAgent =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Alpha)/0.0.33 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36";
      fromPartition.mockReset();
      fromPartition.mockImplementation((partition: string) => {
        let userAgent = nativeUserAgent;
        const browserSession = {
          clearCache: vi.fn(() => Promise.resolve()),
          clearStorageData: vi.fn(() => Promise.resolve()),
          getUserAgent: vi.fn(() => userAgent),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setUserAgent: vi.fn((next: string) => {
            userAgent = next;
          }),
        };
        sessions.set(partition, browserSession);
        return browserSession;
      });

      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      assert.strictEqual(browserSession.getUserAgent(), nativeUserAgent);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("grants clipboard-sanitized-write through both the request and check handlers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);

      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "notifications",
        "geolocation",
        "fullscreen",
      ]) {
        assert.isTrue(requestAllows(permission), `request handler should allow ${permission}`);
        assert.isTrue(
          checkHandler(null, permission) as boolean,
          `check handler should allow ${permission}`,
        );
      }

      // `clipboard-write` is not a real Electron permission — the async write API
      // uses `clipboard-sanitized-write` — so the stale name must not be granted,
      // and unrelated permissions stay denied.
      for (const permission of ["clipboard-write", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("opens custom-scheme links externally only after the user confirms", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);

      const request = (externalURL: string) =>
        Effect.callback<boolean>((resume) => {
          requestHandler(
            null,
            "openExternal",
            (granted: boolean) => resume(Effect.succeed(granted)),
            { externalURL },
          );
        });

      showMessageBox.mockReset();
      showMessageBox.mockReturnValueOnce(0).mockReturnValueOnce(1);
      assert.isTrue(yield* request("slack://open?team=T1"));
      assert.isFalse(yield* request("zoommtg://zoom.us/join"));
      assert.strictEqual(showMessageBox.mock.calls.length, 2);

      for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
        assert.isFalse(yield* request(url), `${url} must never open externally`);
      }
      assert.strictEqual(showMessageBox.mock.calls.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks for camera access and grants only the approved device and origin pair", () =>
    Effect.gen(function* () {
      const media = yield* mediaSession();
      const hostWindow = { id: 9 };
      fromWebContents.mockImplementation((host) =>
        host === media.guest.hostWebContents ? hostWindow : null,
      );
      showMessageBox.mockReturnValue(0);

      assert.isFalse(media.check());
      assert.isTrue(yield* media.request());
      assert.isTrue(media.check());
      assert.isFalse(media.check("https://exam.example", "audio"));
      assert.isFalse(media.check("https://exam.example", "unknown"));
      assert.isFalse(media.check("https://other.example"));
      assert.isTrue(yield* media.request());
      assert.strictEqual(showMessageBox.mock.calls.length, 1);
      assert.deepInclude(showMessageBox.mock.calls[0]?.[0], {
        message: "Allow https://exam.example to use your camera?",
        defaultId: 1,
        cancelId: 1,
      });
      assert.include(showMessageBox.mock.calls[0]?.[0].detail, "https://portal.example");
      assert.strictEqual(showMessageBox.mock.calls[0]?.[1], hostWindow);

      media.guest.getURL.mockReturnValue("https://other-portal.example");
      assert.isFalse(media.check());
      const otherProfile = yield* mediaSession("scope-b");
      assert.isFalse(otherProfile.check());
    }).pipe(Effect.provide(layer)),
  );

  it.effect("remembers a denied microphone without revoking an approved camera", () =>
    Effect.gen(function* () {
      const media = yield* mediaSession();
      showMessageBox.mockReturnValueOnce(0).mockReturnValueOnce(1);
      assert.isTrue(yield* media.request());
      const microphone: Electron.MediaAccessPermissionRequest = {
        requestingUrl: "https://exam.example/microphone-check",
        isMainFrame: false,
        mediaTypes: ["audio", "video"],
      };
      assert.isFalse(yield* media.request(microphone));
      assert.isFalse(yield* media.request(microphone));
      assert.isTrue(media.check());
      assert.isFalse(media.check("https://exam.example", "audio"));
      assert.strictEqual(showMessageBox.mock.calls.length, 2);
      assert.strictEqual(
        showMessageBox.mock.calls[1]?.[0].message,
        "Allow https://exam.example to use your microphone?",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "allows a combined request and revokes its decisions when profile data is cleared",
    () =>
      Effect.gen(function* () {
        const media = yield* mediaSession();
        showMessageBox.mockReturnValue(0);
        assert.isTrue(
          yield* media.request({
            requestingUrl: "https://exam.example/camera-check",
            isMainFrame: false,
            mediaTypes: ["video", "audio"],
          }),
        );
        assert.isTrue(media.check());
        assert.isTrue(media.check("https://exam.example", "audio"));
        assert.include(showMessageBox.mock.calls[0]?.[0].message, "camera and microphone");
        yield* media.browserSessions.clearCookies([media.partition]);
        assert.isFalse(media.check());
        assert.isFalse(media.check("https://exam.example", "audio"));
        assert.isTrue(yield* media.request());
        assert.strictEqual(showMessageBox.mock.calls.length, 2);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("denies opaque, insecure and unknown media requests without prompting", () =>
    Effect.gen(function* () {
      const media = yield* mediaSession();
      showMessageBox.mockReturnValue(0);
      for (const requestingUrl of [
        "file:///tmp/exam.html",
        "http://exam.example",
        "data:text/html,exam",
        "null",
      ]) {
        assert.isFalse(
          yield* media.request({ requestingUrl, isMainFrame: false, mediaTypes: ["video"] }),
        );
      }
      for (const mediaTypes of [[], ["unknown"], ["video", "display"]]) {
        assert.isFalse(
          yield* media.request({
            requestingUrl: "https://exam.example",
            isMainFrame: false,
            mediaTypes,
          }),
        );
      }
      assert.isFalse(
        yield* media.request({
          requestingUrl: "https://exam.example",
          isMainFrame: false,
          securityOrigin: "null",
          mediaTypes: ["video"],
        }),
      );
      assert.strictEqual(showMessageBox.mock.calls.length, 0);

      media.guest.getURL.mockReturnValue("http://localhost:5173");
      assert.isTrue(
        yield* media.request({
          requestingUrl: "http://localhost:5173/camera",
          isMainFrame: true,
          mediaTypes: ["video"],
        }),
      );
      assert.isTrue(media.check("http://localhost:5173"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores approval after the requesting tab changes origin or closes", () =>
    Effect.gen(function* () {
      const media = yield* mediaSession();
      showMessageBox.mockImplementationOnce(() => {
        media.guest.getURL.mockReturnValue("https://other-portal.example");
        return 0;
      });
      assert.isFalse(yield* media.request());
      assert.isFalse(media.check());
      showMessageBox.mockImplementationOnce(() => {
        media.guest.isDestroyed.mockReturnValue(true);
        return 0;
      });
      assert.isFalse(yield* media.request());
      assert.isFalse(media.check());
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects overlapping prompts and ignores approvals after a profile reset", () =>
    Effect.gen(function* () {
      const shown = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<Electron.MessageBoxReturnValue>();
      const heldDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.die("unused"),
        pickFiles: () => Effect.die("unused"),
        showErrorBox: () => Effect.void,
        showMessageBox: () =>
          Deferred.succeed(shown, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      });
      yield* Effect.gen(function* () {
        const media = yield* mediaSession();
        const pending = yield* media.request().pipe(Effect.forkChild);
        yield* Deferred.await(shown);
        assert.isFalse(yield* media.request());
        yield* media.browserSessions.clearCookies([media.partition]);
        yield* Deferred.succeed(answer, { response: 0, checkboxChecked: false });
        assert.isFalse(yield* Fiber.join(pending));
        assert.isFalse(media.check());
        assert.isTrue(yield* media.request());
        assert.isTrue(media.check());
      }).pipe(
        Effect.provide(
          BrowserSession.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, heldDialog))),
        ),
      );
    }),
  );

  // A prompt without an owner can open behind the app window, leaving the one
  // prompt slot taken and every later link silently denied.
  it.effect("attaches the open-externally prompt to the window hosting the preview", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);

      const hostWindow = { id: 7 } as unknown as Electron.BrowserWindow;
      const host = { isDestroyed: () => false };
      const guest = { isDestroyed: () => false, hostWebContents: host };
      fromWebContents.mockImplementation((webContents) =>
        webContents === host ? hostWindow : null,
      );
      showMessageBox.mockReset();
      showMessageBox.mockReturnValueOnce(1);

      yield* Effect.callback<boolean>((resume) => {
        requestHandler(
          guest,
          "openExternal",
          (granted: boolean) => resume(Effect.succeed(granted)),
          {
            externalURL: "slack://open?team=T1",
          },
        );
      });

      assert.strictEqual(showMessageBox.mock.calls[0]?.[1], hostWindow);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves partition scope and the platform failure chain", () => {
    const nativeCause = new Error("native digest failed");
    const platformCause = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "digest",
      cause: nativeCause,
    });
    const layerFailingCrypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(platformCause),
      }),
    );

    return Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const error = yield* browserSessions.getPartition("environment-a").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionPartitionDerivationError);
      assert.equal(error.scope, "environment-a");
      assert.strictEqual(error.cause, platformCause);
      assert.strictEqual(error.cause.reason.cause, nativeCause);
      assert.equal(
        error.message,
        "Failed to derive a desktop preview browser partition for scope environment-a.",
      );
      assert.notInclude(error.message, nativeCause.message);
    }).pipe(
      Effect.provide(
        BrowserSession.layer.pipe(Layer.provide(Layer.merge(layerFailingCrypto, layerDialog))),
      ),
    );
  });

  it.effect("preserves session scope, partition, and the Electron failure", () =>
    Effect.gen(function* () {
      const cause = new Error("Electron session failed");
      fromPartition.mockImplementationOnce(() => {
        throw cause;
      });
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("environment-b");
      const error = yield* browserSessions.getSession("environment-b").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionCreationError);
      assert.equal(error.scope, "environment-b");
      assert.equal(error.partition, partition);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to create a desktop preview browser session for scope environment-b (partition ${partition}).`,
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears storage and cache for every created session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");

      yield* browserSessions.clearCookies();
      yield* browserSessions.clearCache();

      assert.strictEqual(sessions.size, 2);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
        assert.deepEqual(browserSession.clearStorageData.mock.calls[0], [
          {
            storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
          },
        ]);
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears a partition whose session has not been opened yet", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-untouched");

      // Deriving the partition string does not create the session, and the
      // clear only walks sessions it already holds. Without loading it first
      // this reports success and deletes nothing — which is what a user
      // clearing a profile after a restart would get.
      assert.isUndefined(sessions.get(partition));
      yield* browserSessions.clearCookies([partition]);
      assert.isUndefined(sessions.get(partition));

      yield* browserSessions.getSession("scope-untouched");
      yield* browserSessions.clearCookies([partition]);

      const created = sessions.get(partition);
      assert.isDefined(created);
      assert.strictEqual(created.clearStorageData.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("correlates clear failures while still attempting every session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");
      const firstPartition = yield* browserSessions.getPartition("scope-a");
      const secondPartition = yield* browserSessions.getPartition("scope-b");
      const firstSession = sessions.get(firstPartition);
      const secondSession = sessions.get(secondPartition);
      assert.isDefined(firstSession);
      assert.isDefined(secondSession);

      const storageCause = new Error("storage clear failed");
      secondSession.clearStorageData.mockImplementationOnce(() => Promise.reject(storageCause));
      const storageError = yield* browserSessions.clearCookies().pipe(Effect.flip);

      assert.instanceOf(storageError, BrowserSession.BrowserSessionStorageClearError);
      assert.equal(storageError.partition, secondPartition);
      assert.strictEqual(storageError.cause, storageCause);
      assert.equal(
        storageError.message,
        `Failed to clear desktop preview browser storage for partition ${secondPartition}.`,
      );
      assert.notInclude(storageError.message, storageCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
      }

      const cacheCause = new Error("cache clear failed");
      firstSession.clearCache.mockImplementationOnce(() => Promise.reject(cacheCause));
      const cacheError = yield* browserSessions.clearCache().pipe(Effect.flip);

      assert.instanceOf(cacheError, BrowserSession.BrowserSessionCacheClearError);
      assert.equal(cacheError.partition, firstPartition);
      assert.strictEqual(cacheError.cause, cacheCause);
      assert.equal(
        cacheError.message,
        `Failed to clear the desktop preview browser cache for partition ${firstPartition}.`,
      );
      assert.notInclude(cacheError.message, cacheCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});
