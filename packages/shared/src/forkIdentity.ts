// Identity of the fork's macOS desktop app (issue #95).
//
// Every value here is what keeps the fork's app from sharing state with
// upstream T3 Code or with the fork's LaunchAgent server: bundle id, name,
// app data folder, T3 home, URL scheme, backend port, compile cache and the
// service launchd label. The desktop app, scripts/build-desktop-artifact.ts,
// apps/server/src/cloud/bootService.ts and the dev launcher all import from
// here. apps/desktop/src/compileCache.ts cannot: it must bundle on its own
// (see main-process-bundle.test.mjs), so it mirrors FORK_COMPILE_CACHE_DIR_NAME.
//
// Plain constants only, so the dev launcher can import this file under Node
// without a build step.

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

/** The LaunchAgent server the packaged desktop app uses as its primary environment. */
export const FORK_FACTORY_SERVER_URL = "http://127.0.0.1:3876";

export const FORK_COMPILE_CACHE_DIR_NAME = "t3code-factory";

export const FORK_BOOT_SERVICE_LAUNCHD_LABEL = `${FORK_DESKTOP_APP_ID}.service`;

// Identity of the fork's React Native app (issue #146), so it installs beside
// upstream's App Store T3 Code. One id serves iOS and Android: Android package
// names cannot contain the hyphens in FORK_DESKTOP_APP_ID.
// apps/mobile/src/factory/mobileIdentity.ts applies these to app.config.ts.

export const FORK_MOBILE_APP_ID = "au.com.originalsolutions.t3codefactory";

export const FORK_MOBILE_VARIANTS = {
  development: {
    appName: `${FORK_PRODUCT_NAME} Dev`,
    scheme: "t3code-factory-dev",
    appId: `${FORK_MOBILE_APP_ID}.dev`,
  },
  preview: {
    appName: `${FORK_PRODUCT_NAME} Preview`,
    scheme: "t3code-factory-preview",
    appId: `${FORK_MOBILE_APP_ID}.preview`,
  },
  production: {
    appName: FORK_PRODUCT_NAME,
    scheme: "t3code-factory",
    appId: FORK_MOBILE_APP_ID,
  },
} as const;

/** The Apple team that signs the fork's desktop app (APPLE_TEAM_ID of desktop-release). */
export const FORK_APPLE_TEAM_ID = "3TB6CJ6ZHV";

/** The desktop's passkey domain (CLERK_PASSKEY_RP_DOMAINS). */
export const FORK_MOBILE_ASSOCIATED_DOMAIN = "originalsolutions.com.au";
