// Identity of the fork's macOS desktop app (issue #95).
//
// Every value here is what keeps the fork's app from sharing state with
// upstream T3 Code or with the fork's LaunchAgent server: bundle id, name,
// app data folder, T3 home, URL scheme, backend port, compile cache and the
// service launchd label. The desktop app, scripts/build-desktop-artifact.ts and
// apps/server/src/cloud/bootService.ts all import from here.
//
// Plain constants and pure functions only: compileCache.ts imports this before
// any Effect runtime exists.

export const FORK_DESKTOP_APP_ID = "io.github.original-solutions.t3code-factory";
export const FORK_DESKTOP_DEV_APP_ID = `${FORK_DESKTOP_APP_ID}.dev`;

export const FORK_PRODUCT_NAME = "T3 Code Factory";
export const FORK_NIGHTLY_PRODUCT_NAME = `${FORK_PRODUCT_NAME} (Nightly)`;

export const FORK_APP_DATA_FOLDER = "t3code-factory";
export const FORK_DEV_APP_DATA_FOLDER = "t3code-factory-dev";

/** Profiles of earlier desktop generations to import from. The fork has none. */
export const FORK_LEGACY_APP_DATA_FOLDERS: readonly string[] = [];

/** Default T3 home, relative to the user's home directory. */
export const FORK_T3_HOME_DIR_NAME = ".t3code-factory";

export const FORK_DESKTOP_SCHEME = "t3code-factory";
export const FORK_DESKTOP_DEV_SCHEME = "t3code-factory-dev";

/** First port the desktop backend scan tries. Upstream desktop uses 3773, the LaunchAgent server 3876. */
export const FORK_DESKTOP_BACKEND_PORT = 3880;

export const FORK_COMPILE_CACHE_DIR_NAME = "t3code-factory";

export const FORK_BOOT_SERVICE_LAUNCHD_LABEL = `${FORK_DESKTOP_APP_ID}.service`;
