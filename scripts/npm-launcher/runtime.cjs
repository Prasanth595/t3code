"use strict";
/**
 * Shared by the `t3` npm package's entry points. It downloads the release
 * archive for this package's exact version from GitHub Releases into
 * `<T3 home>/runtime/versions/<version>`, which is the layout the install
 * scripts, `t3 update`, and the background service use, so all of them reuse
 * one download. Plain CommonJS with no dependencies, so it loads on any Node
 * that npm runs on.
 *
 * The naming here mirrors packages/shared/src/cliRelease.ts and the pinned
 * runtime in apps/server/src/cloud/pinnedRuntime.ts; a rename there is a
 * rename here.
 */
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { version } = require("../package.json");

const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
const DEFAULT_BASE_URL = "https://github.com/pingdotgg/t3code/releases/download";

class LauncherError extends Error {}

function t3Home(env) {
  const raw = (env.T3CODE_HOME || "").trim();
  if (raw === "") return path.join(os.homedir(), ".t3");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function runtimePaths(env, platform) {
  const versionDir = path.join(t3Home(env), "runtime", "versions", version);
  return {
    versionDir,
    executable: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinel: path.join(versionDir, ".install-complete"),
  };
}

function isInstalled(paths) {
  try {
    return (
      fs.readFileSync(paths.sentinel, "utf8").trim() === version && fs.existsSync(paths.executable)
    );
  } catch {
    return false;
  }
}

async function fetchOk(url) {
  let response;
  try {
    response = await fetch(url, { headers: { "User-Agent": `t3-npm/${version}` } });
  } catch (cause) {
    throw new LauncherError(`could not reach ${url}: ${cause.message}`);
  }
  if (response.status === 404) {
    throw new LauncherError(
      `t3 ${version} has no release archive at ${url}. The release may still be publishing; try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new LauncherError(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

/** Streams the archive to `file`, hashing as it goes, with a progress line on a terminal. */
async function download(url, file) {
  const response = await fetchOk(url);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const interactive = process.stderr.isTTY && process.env.TERM !== "dumb";
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      const percent = total > 0 ? Math.floor((received * 100) / total) : -1;
      if (interactive && percent !== shown) {
        shown = percent;
        const mb = (received / 1048576).toFixed(1);
        process.stderr.write(
          `\r\x1b[2Kt3: downloading T3 Code ${version}  ${percent >= 0 ? `${percent}%  ` : ""}${mb} MB`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (interactive) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

/**
 * Returns the path of this version's executable, downloading and verifying
 * the release archive first unless a complete install is already there.
 */
async function ensureRuntime() {
  const platform = process.platform;
  const key = `${platform}-${process.arch}`;
  if (!SUPPORTED.includes(key)) {
    throw new LauncherError(
      [
        `no T3 Code CLI build is available for this platform (${key}).`,
        `Supported platforms: ${SUPPORTED.join(", ")}.`,
        "The desktop app is at https://github.com/pingdotgg/t3code/releases",
      ].join("\n"),
    );
  }
  const paths = runtimePaths(process.env, platform);
  if (isInstalled(paths)) return paths.executable;

  const baseUrl = `${(process.env.T3CODE_RELEASE_BASE_URL || "").trim().replace(/\/+$/, "") || DEFAULT_BASE_URL}/v${version}`;
  const archive = `t3-${version}-${key}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const versionsDir = path.dirname(paths.versionDir);
  fs.mkdirSync(versionsDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(versionsDir, ".staging-"));
  try {
    const sums = await (await fetchOk(`${baseUrl}/SHA256SUMS`)).text();
    const expected = sums
      .split(/\r?\n/)
      .map((line) => /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim()))
      .find((match) => match !== null && match[2] === archive)?.[1];
    if (expected === undefined) throw new LauncherError(`${archive} is not listed in SHA256SUMS`);

    const archivePath = path.join(staging, archive);
    const actual = await download(`${baseUrl}/${archive}`, archivePath);
    if (actual !== expected.toLowerCase()) {
      throw new LauncherError(`checksum mismatch for ${archive}`);
    }
    // Windows ships bsdtar, which reads zip; a Git-for-Windows GNU tar earlier
    // on PATH cannot, so the system copy is named by absolute path.
    const tar =
      platform === "win32"
        ? path.join(
            process.env.SystemRoot || process.env.windir || "C:\\Windows",
            "System32",
            "tar.exe",
          )
        : "tar";
    const extracted = spawnSync(tar, ["-xf", archivePath, "-C", staging, "--strip-components=1"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (extracted.error || extracted.status !== 0) {
      throw new LauncherError(
        `could not extract ${archive}${extracted.error ? `: ${extracted.error.message}` : ""}`,
      );
    }
    fs.rmSync(archivePath, { force: true });
    // Written last: tar writes the executable before the native packages, so
    // its presence alone does not mean the install is complete.
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    fs.rmSync(paths.versionDir, { recursive: true, force: true });
    try {
      fs.renameSync(staging, paths.versionDir);
    } catch (cause) {
      // Another launcher finished the same version first.
      if (!isInstalled(paths)) throw cause;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return paths.executable;
}

/** Runs `main`, printing a launcher failure as one line rather than a stack. */
function runLauncher(main) {
  main().catch((error) => {
    process.stderr.write(
      `t3: ${error instanceof LauncherError ? error.message : (error && error.stack) || error}\n`,
    );
    process.exit(1);
  });
}

module.exports = { ensureRuntime, runLauncher };
