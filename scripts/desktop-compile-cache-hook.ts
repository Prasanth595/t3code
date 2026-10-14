// @effect-diagnostics nodeBuiltinImport:off -- electron-builder loads this hook into its own process, where no Effect runtime exists.
// @effect-diagnostics globalConsole:off -- same reason
/**
 * electron-builder `afterPack` hook for Linux builds. It warms Node's compile
 * cache for the packaged main and backend bundles into resources/compile-cache
 * before the AppImage is assembled, so AppImage launches start from a full
 * cache instead of recompiling both bundles every time. The cache is written
 * in portable mode, keyed relative to its own directory, which is what the
 * runtime expects: see apps/desktop/src/compileCache.ts.
 *
 * Both warm runs use the packaged Electron binary in Node mode with the
 * packaged cache preload, so the entries carry the V8 version and flag tag the
 * shipped app checks at load time. Node writes an entry when it compiles a
 * module, so the main bundle only has to be compiled: it throws while
 * evaluating outside Electron, after its entry is already cached. The backend
 * runs to HTTP readiness so every chunk the startup path imports is compiled,
 * then flushes its own cache (serverRuntimeStartup.ts) before it is stopped.
 * The warm backend runs with product analytics off and a scratch home.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const sleep = NodeTimersPromises.setTimeout;

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly executableName: string };
}

const READINESS_PATH = "/.well-known/t3/environment";
const READINESS_TIMEOUT_MS = 120_000;
const FLUSH_TIMEOUT_MS = 30_000;
const FLUSH_SETTLE_MS = 1_000;
const MAIN_WARM_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 10_000;
const SHIPPED_CACHE_UID = 1000;
const CACHE_ENTRY_NAME = /^[0-9a-f]{8}$/;

// A deadline must not keep electron-builder's process alive after the work is done.
const deadline = (ms: number) => sleep(ms, null, { ref: false });

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("Could not reserve a loopback port for the compile cache warm-up."));
          return;
        }
        resolve(address.port);
      });
    });
  });

const probeReady = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path: READINESS_PATH, method: "GET", timeout: 1_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.once("error", () => resolve(false));
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });

interface WarmChild {
  readonly child: NodeChildProcess.ChildProcess;
  readonly exited: Promise<string>;
  readonly stderrPath: string;
}

function spawnWarm(
  electron: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  stderrPath: string,
): WarmChild {
  const stderr = NodeFS.openSync(stderrPath, "w");
  const child = NodeChildProcess.spawn(electron, args, {
    env,
    stdio: ["ignore", "ignore", stderr],
  });
  const exited = new Promise<string>((resolve) =>
    child.once("exit", (code, signal) => {
      NodeFS.closeSync(stderr);
      resolve(signal ?? String(code));
    }),
  );
  return { child, exited, stderrPath };
}

async function stop(warm: WarmChild): Promise<string> {
  warm.child.kill("SIGTERM");
  const result = await Promise.race([warm.exited, deadline(KILL_GRACE_MS)]);
  if (result !== null) return result;
  warm.child.kill("SIGKILL");
  return warm.exited;
}

async function stderrTail(warm: WarmChild): Promise<string> {
  const text = await NodeFSP.readFile(warm.stderrPath, "utf8").catch(() => "");
  return text.split("\n").slice(-40).join("\n");
}

async function countEntries(cacheDir: string): Promise<number> {
  const entries = await NodeFSP.readdir(cacheDir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

async function warmMain(
  electron: string,
  preload: string,
  mainEntry: string,
  env: NodeJS.ProcessEnv,
  stderrPath: string,
): Promise<void> {
  // Electron APIs are unavailable in Node mode, so the main bundle fails while
  // evaluating, after its entry is compiled and cached. Whatever it started
  // before failing would keep the process alive, so flush and exit right away.
  const warm = spawnWarm(
    electron,
    [
      "--require",
      preload,
      "--eval",
      'try { require(process.argv[1]); } catch {} require("node:module").flushCompileCache(); process.exit(0);',
      mainEntry,
    ],
    env,
    stderrPath,
  );
  const result = await Promise.race([warm.exited, deadline(MAIN_WARM_TIMEOUT_MS)]);
  if (result === null) {
    await stop(warm);
    throw new Error(
      `Compiling the main bundle for the compile cache did not finish within ${MAIN_WARM_TIMEOUT_MS}ms.\n${await stderrTail(warm)}`,
    );
  }
}

async function warmBackend(
  electron: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cacheDir: string,
  stderrPath: string,
): Promise<void> {
  const before = await countEntries(cacheDir);
  const port = await freePort();
  const warm = spawnWarm(
    electron,
    [...args, "--mode", "desktop", "--port", String(port), "--host", "127.0.0.1", "--no-browser"],
    env,
    stderrPath,
  );
  const fail = async (reason: string): Promise<never> => {
    const exit = await stop(warm);
    throw new Error(`${reason} (backend exit: ${exit})\n${await stderrTail(warm)}`);
  };

  const readyDeadline = performance.now() + READINESS_TIMEOUT_MS;
  let ready = false;
  while (
    !ready &&
    warm.child.exitCode === null &&
    warm.child.signalCode === null &&
    performance.now() < readyDeadline
  ) {
    ready = await probeReady(port);
    if (!ready) await sleep(50);
  }
  if (!ready) {
    return fail(
      `The packaged backend did not report readiness on 127.0.0.1:${port} within ${READINESS_TIMEOUT_MS}ms, so the compile cache was not warmed.`,
    );
  }

  // Readiness is answered before the server flushes its compile cache. Wait
  // for the flush to land and the entry count to hold still before stopping.
  const flushDeadline = performance.now() + FLUSH_TIMEOUT_MS;
  let count = before;
  let settledSince = performance.now();
  while (performance.now() < flushDeadline) {
    const next = await countEntries(cacheDir);
    if (next !== count) {
      count = next;
      settledSince = performance.now();
    } else if (count > before && performance.now() - settledSince >= FLUSH_SETTLE_MS) {
      break;
    }
    await sleep(100);
  }
  if (count <= before) {
    return fail(
      `The packaged backend reached readiness but wrote no compile cache entries within ${FLUSH_TIMEOUT_MS}ms.`,
    );
  }
  await stop(warm);
}

// Node 24 names the entry directory <version>-<arch>-<v8 tag>-<uid> even in
// portable mode and only looks for the directory of the running uid, so a
// cache warmed by a build runner would never be found. Ship it under uid 1000,
// the first user account on the common desktop distributions; other uids get
// no cache. Node 26 drops the uid from portable caches (nodejs/node#65293);
// once Electron ships that, the directory has no uid suffix and is shipped as
// it is, for every uid.
async function shipTagDirectory(cacheDir: string): Promise<string> {
  const tagDirs = await NodeFSP.readdir(cacheDir);
  const tagDir = tagDirs[0];
  if (tagDirs.length !== 1 || tagDir === undefined) {
    throw new Error(
      `Expected one compile cache tag directory in ${cacheDir}, found ${tagDirs.length}: ${tagDirs.join(", ")}`,
    );
  }
  const uidSuffix = `-${process.getuid?.() ?? ""}`;
  if (!tagDir.endsWith(uidSuffix)) return NodePath.join(cacheDir, tagDir);
  const shipped = `${tagDir.slice(0, -uidSuffix.length)}-${SHIPPED_CACHE_UID}`;
  if (shipped !== tagDir) {
    await NodeFSP.rename(NodePath.join(cacheDir, tagDir), NodePath.join(cacheDir, shipped));
  }
  return NodePath.join(cacheDir, shipped);
}

// Node writes entries through 0600 temp files. The image is read by whoever
// runs it, and a stopped child can leave its temp file behind.
async function finalizeEntries(tagDir: string): Promise<number> {
  await NodeFSP.chmod(NodePath.dirname(tagDir), 0o755);
  await NodeFSP.chmod(tagDir, 0o755);
  let count = 0;
  for (const name of await NodeFSP.readdir(tagDir)) {
    const file = NodePath.join(tagDir, name);
    if (!CACHE_ENTRY_NAME.test(name)) {
      await NodeFSP.rm(file, { force: true });
      continue;
    }
    await NodeFSP.chmod(file, 0o644);
    count += 1;
  }
  return count;
}

export default async function afterPack(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== "linux") return;

  const resourcesDir = NodePath.join(context.appOutDir, "resources");
  const asarDir = NodePath.join(resourcesDir, "app.asar");
  const cacheDir = NodePath.join(resourcesDir, "compile-cache");
  const electron = NodePath.join(context.appOutDir, context.packager.executableName);
  const preload = NodePath.join(asarDir, "apps/desktop/dist-electron/compileCache.cjs");
  const mainEntry = NodePath.join(asarDir, "apps/desktop/dist-electron/main.cjs");
  const backendEntry = NodePath.join(asarDir, "apps/server/dist/bin.mjs");

  // Keep every file the warm-up writes inside one scratch directory.
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-compile-cache-"));
  const t3Home = NodePath.join(scratch, "t3");
  // Only what the warm runs need. The release job's environment carries
  // signing secrets, and NODE_OPTIONS would change the V8 flag tag.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
    ELECTRON_RUN_AS_NODE: "1",
    // The preload selects the shipped portable cache only under AppImage.
    APPIMAGE: electron,
    HOME: scratch,
    XDG_CACHE_HOME: NodePath.join(scratch, "cache"),
    XDG_CONFIG_HOME: NodePath.join(scratch, "config"),
    XDG_DATA_HOME: NodePath.join(scratch, "data"),
    T3CODE_HOME: t3Home,
    T3CODE_TELEMETRY_ENABLED: "false",
  };
  try {
    await NodeFSP.mkdir(cacheDir, { recursive: true });
    await warmMain(electron, preload, mainEntry, env, NodePath.join(scratch, "main.stderr"));
    if ((await countEntries(cacheDir)) === 0) {
      throw new Error(`Compiling the main bundle wrote no compile cache entry to ${cacheDir}.`);
    }
    await warmBackend(
      electron,
      ["--require", preload, backendEntry, "serve", "--base-dir", t3Home],
      env,
      cacheDir,
      NodePath.join(scratch, "backend.stderr"),
    );
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }

  const tagDir = await shipTagDirectory(cacheDir);
  const count = await finalizeEntries(tagDir);
  console.log(`[desktop-artifact] Warmed ${count} compile cache entries at ${tagDir}.`);
}
