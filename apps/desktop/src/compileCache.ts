// @effect-diagnostics nodeBuiltinImport:off
// Runs before any Effect runtime exists, so it stays on Node built-ins.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Turns on Node's on-disk V8 code cache for every module loaded after this one,
// so later launches skip recompiling the large main and server bundles.
// Packaged builds only: boot.ts loads it for the main process, and the local
// backend gets it with `--require`. Dev launches main.cjs directly and skips it.
// Linux uses the user's cache dir because /tmp is shared between users; the
// macOS and Windows temp dirs are already per user.
//
// AppImage mounts the app at a new /tmp/.mount_* path each launch, and Node
// keys entries by absolute path, so a per-user cache would miss every launch
// and leave another copy behind. AppImage instead reads the portable cache the
// Linux build ships next to app.asar (scripts/desktop-compile-cache-hook.ts).
// Its keys are relative to the cache directory, so every mount hits; the image
// is read-only, so misses are compiled and never written. Node 24 looks the
// cache up by uid and the build ships uid 1000, so other uids run without a
// cache until Node drops the uid from portable caches. The backend inherits
// APPIMAGE, so this covers it too.
try {
  if (process.env.APPIMAGE) {
    NodeModule.enableCompileCache({
      // This file is resources/app.asar/apps/desktop/dist-electron/compileCache.cjs.
      directory: NodePath.resolve(__dirname, "../../../..", "compile-cache"),
      portable: true,
    });
  } else {
    const cacheRoot =
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Loads before any Effect runtime.
      process.platform === "linux"
        ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
        : NodeOS.tmpdir();
    NodeModule.enableCompileCache(NodePath.join(cacheRoot, "t3code", "compile-cache"));
  }
} catch {
  // The cache is only a speedup. Never let it stop the app from starting.
}
