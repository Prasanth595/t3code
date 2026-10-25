// Play signs generated APKs with the app signing key, matching Play Store installs.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function playAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key);
  const response = await fetch(key.token_uri, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature.toString("base64url")}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

async function play(token, method, url) {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

// Opening an edit would invalidate any EAS Submit edit using the same service account.
async function newestTrackBuild(token, appUrl, trackName) {
  const { releases = [] } = await (
    await play(token, "GET", `${appUrl}/tracks/${trackName}/releases`)
  ).json();
  let newest;
  for (const release of releases) {
    if (release.releaseLifecycleState !== "RELEASE_LIFECYCLE_STATE_PUBLISHED") continue;
    for (const { versionCode } of release.activeArtifacts ?? []) {
      if (!newest || versionCode > newest.versionCode) {
        newest = { versionCode, versionName: release.releaseName || String(versionCode) };
      }
    }
  }
  return newest;
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function readRelease(tag) {
  try {
    return JSON.parse(gh("release", "view", tag, "--json", "assets,body,isDraft"));
  } catch {
    return undefined;
  }
}

const ABI_NAMES = {
  ARMEABI_V7A: "armeabi-v7a",
  ARM64_V8A: "arm64-v8a",
  X86: "x86",
  X86_64: "x86_64",
};

async function generatedApks(token, appUrl, build) {
  const generated = await (
    await play(token, "GET", `${appUrl}/generatedApks/${build.versionCode}`)
  ).json();
  const withUniversal = (generated.generatedApks ?? []).filter(
    (entry) => entry.generatedUniversalApk,
  );
  if (withUniversal.length > 1) {
    throw new Error(`Play returned ${withUniversal.length} universal APKs, one per signing key.`);
  }
  return withUniversal[0];
}

// Each set holds one ABI split plus the base and every density and language
// split of the lowest-SDK variant, so it installs on any device with that ABI.
function planSplitApkSets(signingKey, packageName) {
  const downloadIds = new Set((signingKey.generatedSplitApks ?? []).map((apk) => apk.downloadId));
  const minSdk = (variant) =>
    Math.min(
      Infinity,
      ...(variant.targeting?.sdkVersionTargeting?.value ?? []).map((sdk) => sdk.min ?? 0),
    );
  const [variant] = [...(signingKey.targetingInfo?.variant ?? [])].sort(
    (a, b) => minSdk(a) - minSdk(b) || (a.variantNumber ?? 0) - (b.variantNumber ?? 0),
  );
  if (!variant || downloadIds.size === 0) return [];
  let base;
  const shared = [];
  const byAbi = new Map();
  for (const { moduleMetadata, apkDescription = [] } of variant.apkSet ?? []) {
    const deliveryType = moduleMetadata?.deliveryType ?? "INSTALL_TIME";
    if (deliveryType !== "INSTALL_TIME" && deliveryType !== "DELIVERY_TYPE_UNSPECIFIED") continue;
    const moduleName = moduleMetadata?.name ?? "base";
    for (const { path: apkPath, splitApkMetadata, targeting } of apkDescription) {
      if (!splitApkMetadata) continue;
      const downloadId = apkPath.replace(/\.apk$/, "");
      if (!downloadIds.has(downloadId)) {
        throw new Error(`Play targeting lists ${apkPath}, which is not a generated split APK.`);
      }
      const isBase = moduleName === "base" && splitApkMetadata.isMasterSplit;
      const piece = {
        downloadId,
        fileName: isBase
          ? `${packageName}.apk`
          : `split_${splitApkMetadata.splitId || moduleName}.apk`,
      };
      const abis = (targeting?.abiTargeting?.value ?? []).map(({ alias }) => alias);
      if (isBase) base = piece;
      else if (abis.length === 0) shared.push(piece);
      for (const alias of abis) {
        const abi = ABI_NAMES[alias] ?? alias.toLowerCase();
        byAbi.set(abi, [...(byAbi.get(abi) ?? []), piece]);
      }
    }
  }
  if (byAbi.size === 0) return [];
  if (!base) throw new Error(`Play variant ${variant.variantNumber} has no base APK.`);
  return [...byAbi].map(([abi, pieces]) => ({ abi, pieces: [base, ...shared, ...pieces] }));
}

async function download({ token, appUrl, build, downloadId, filePath }) {
  const response = await play(
    token,
    "GET",
    `${appUrl}/generatedApks/${build.versionCode}/downloads/${encodeURIComponent(downloadId)}:download?alt=media`,
  );
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
}

// The zip deflates native libraries that the APKs store uncompressed.
async function downloadAssets({ token, appUrl, build, signingKey, apkName, splitSets, directory }) {
  const assets = [path.join(directory, apkName)];
  await download({
    token,
    appUrl,
    build,
    downloadId: signingKey.generatedUniversalApk.downloadId,
    filePath: assets[0],
  });
  const piecesDirectory = path.join(directory, "pieces");
  fs.mkdirSync(piecesDirectory);
  const downloaded = new Set();
  try {
    for (const { name, pieces } of splitSets) {
      for (const { downloadId, fileName } of pieces) {
        if (downloaded.has(fileName)) continue;
        await download({
          token,
          appUrl,
          build,
          downloadId,
          filePath: path.join(piecesDirectory, fileName),
        });
        downloaded.add(fileName);
      }
      const setPath = path.join(directory, name);
      execFileSync(
        "zip",
        [
          "-q",
          "-j",
          "-9",
          setPath,
          ...pieces.map(({ fileName }) => path.join(piecesDirectory, fileName)),
        ],
        { stdio: "inherit" },
      );
      assets.push(setPath);
    }
  } catch (error) {
    console.warn(`Skipping split APK sets: ${error.message}`);
    return assets.slice(0, 1);
  }
  return assets;
}

function isUploaded(release, name) {
  return release?.assets.some(
    (asset) => asset.name === name && asset.state === "uploaded" && asset.size > 0,
  );
}

function isPublished(release, names) {
  return release && !release.isDraft && names.every((name) => isUploaded(release, name));
}

function publishBeta(tag, assetPaths, notes, title) {
  const release = readRelease(tag);
  if (
    isPublished(
      release,
      assetPaths.map((assetPath) => path.basename(assetPath)),
    )
  )
    return;
  if (!release) {
    gh(
      "release",
      "create",
      tag,
      "--draft",
      "--prerelease",
      "--latest=false",
      "--title",
      title,
      "--notes",
      notes,
    );
  }
  // --clobber deletes an asset before replacing it, so leave complete ones alone.
  const missing = assetPaths.filter((assetPath) => !isUploaded(release, path.basename(assetPath)));
  if (missing.length > 0) gh("release", "upload", tag, ...missing, "--clobber");
  gh(
    "release",
    "edit",
    tag,
    "--draft=false",
    "--prerelease",
    "--latest=false",
    "--title",
    title,
    "--notes",
    notes,
  );
}

async function main() {
  const packageName = requireEnv("PACKAGE_NAME");
  const outputDirectory = process.env.APK_OUTPUT_DIR;
  const channel = outputDirectory ? "internal" : "beta";
  const track = outputDirectory ? "internal" : "alpha";
  const token = await playAccessToken(JSON.parse(requireEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")));
  const appUrl = `${PLAY_API}/${packageName}`;
  const build = await newestTrackBuild(token, appUrl, track);
  if (!build) {
    console.log(`The ${track} track has no live release.`);
    return;
  }
  const safeName = build.versionName.replace(/[^0-9A-Za-z.]+/g, "-").replace(/^-|-$/g, "");
  const assetPrefix = `t3code-android-${channel}-${safeName}-${build.versionCode}`;
  const apkName = `${assetPrefix}.apk`;
  const tag = `android-beta-${build.versionCode}`;
  const signingKey = await generatedApks(token, appUrl, build);
  if (!signingKey) {
    console.log(`Play is still processing the ${track} APK for ${build.versionCode}.`);
    return;
  }
  let splitSets = [];
  try {
    splitSets = planSplitApkSets(signingKey, packageName).map((set) => ({
      ...set,
      name: `${assetPrefix}-${set.abi}.apks`,
    }));
  } catch (error) {
    // The universal APK still installs everywhere, so publish it alone.
    console.warn(`Skipping split APK sets: ${error.message}`);
  }
  const assetNames = [apkName, ...splitSets.map(({ name }) => name)];
  if (!outputDirectory && isPublished(readRelease(tag), assetNames)) {
    console.log(`${assetNames.join(", ")} are already published.`);
    return;
  }
  // Stage downloads so failed requests cannot leave partial release assets.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-"));
  try {
    const assetPaths = await downloadAssets({
      token,
      appUrl,
      build,
      signingKey,
      apkName,
      splitSets,
      directory,
    });
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      for (const assetPath of assetPaths) {
        const destination = path.join(outputDirectory, path.basename(assetPath));
        const temporary = `${destination}.tmp`;
        try {
          fs.copyFileSync(assetPath, temporary);
          fs.renameSync(temporary, destination);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
      return;
    }
    const notes = [
      `T3 Code for Android beta, mirrored from Google Play closed testing. Build: ${build.versionName} (${build.versionCode}).`,
      "",
      "These builds have been promoted for wider testing, but may still contain bugs. The beta is optional; the store app also works with Nightly servers.",
      "",
      "The `.apk` installs on any device. Each `.apks` file is a much smaller zip of split APKs for one CPU architecture. Install it with Obtainium or SAI, or unzip it and use `adb install-multiple`.",
    ].join("\n");
    // The build number makes retries and unchanged hourly checks idempotent.
    publishBeta(tag, assetPaths, notes, `Android beta ${build.versionName} (${build.versionCode})`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { planSplitApkSets };
