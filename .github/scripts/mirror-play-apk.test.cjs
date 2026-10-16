const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source =
  fs.readFileSync(path.join(__dirname, "mirror-play-apk.cjs"), "utf8").split("main().catch(")[0] +
  "\nglobalThis.run = main;";

function fixture(outputDirectory) {
  const releases = new Map();
  const calls = [];
  const tracks = [];
  let versionCode = 41;
  let processing = false;
  let failUpload = false;
  const context = {
    require(name) {
      if (name === "node:crypto") return { sign: () => Buffer.from("signature") };
      if (name === "node:child_process")
        return {
          execFileSync(_, args) {
            calls.push(args);
            const [, command, tag] = args;
            if (command === "view") {
              if (!releases.has(tag)) throw Error("not found");
              return JSON.stringify(releases.get(tag));
            }
            if (command === "create") releases.set(tag, { assets: [], body: "", isDraft: true });
            const release = releases.get(tag);
            if (command === "upload") {
              if (failUpload) {
                failUpload = false;
                throw Error("upload failed");
              }
              const name = path.basename(args[3]);
              release.assets = release.assets.filter((asset) => asset.name !== name);
              release.assets.push({ name, state: "uploaded", size: fs.statSync(args[3]).size });
            }
            if (command === "edit") {
              release.isDraft = false;
              release.body = args[args.indexOf("--notes") + 1];
            }
            if (command === "delete-asset")
              release.assets = release.assets.filter((asset) => asset.name !== args[3]);
            return "";
          },
        };
      return require(name);
    },
    process: {
      env: {
        PACKAGE_NAME: "test.app",
        RELEASE_TAG: "android-beta",
        APK_OUTPUT_DIR: outputDirectory,
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
          token_uri: "https://token",
          client_email: "test",
          private_key: "test",
        }),
      },
    },
    Buffer,
    URLSearchParams,
    console,
    fetch: async (url) => {
      if (url === "https://token") return Response.json({ access_token: "token" });
      if (url.endsWith("/releases")) {
        tracks.push(url.includes("/alpha/") ? "alpha" : "internal");
        return Response.json({
          releases: [
            {
              releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
              releaseName: "2.0.0",
              activeArtifacts: [{ versionCode }],
            },
          ],
        });
      }
      if (!url.includes("/downloads/"))
        return Response.json({
          generatedApks: processing ? [] : [{ generatedUniversalApk: { downloadId: "apk" } }],
        });
      return new Response("signed APK");
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    releases,
    calls,
    tracks,
    run: context.run,
    nextBuild: () => versionCode++,
    setProcessing: (value) => (processing = value),
    failNextUpload: () => {
      failUpload = true;
    },
  };
}

test("only new closed-testing betas create releases and the rolling page keeps one APK", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual([...f.releases.keys()], ["android-beta-41", "android-beta"]);
  assert(f.releases.get("android-beta").assets[0].name.includes("-beta-"));
  assert(!f.releases.get("android-beta").body.includes("internal"));
  const mutations = () => f.calls.filter((args) => args[1] !== "view").length;
  const before = mutations();
  await f.run();
  assert.equal(mutations(), before);
  f.nextBuild();
  f.setProcessing(true);
  await f.run();
  assert.equal(mutations(), before);
  f.setProcessing(false);
  await f.run();
  assert(f.releases.has("android-beta-42"));
  assert(f.releases.has("android-beta-41"));
  assert.equal(f.releases.get("android-beta").assets.length, 1);
  assert(f.releases.get("android-beta").assets[0].name.endsWith("-42.apk"));
  assert(f.tracks.every((track) => track === "alpha"));
});

test("failed beta uploads resume their draft before advancing the rolling page", async () => {
  const f = fixture();
  f.failNextUpload();
  await assert.rejects(f.run(), /upload failed/);
  assert.equal(f.releases.get("android-beta-41").isDraft, true);
  assert(!f.releases.has("android-beta"));
  await f.run();
  assert.equal(f.releases.get("android-beta-41").isDraft, false);
  assert.equal(
    f.calls.filter((args) => args[1] === "create" && args[2] === "android-beta-41").length,
    1,
  );
});

test("nightly stages an internal APK without creating or editing GitHub releases", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-apk-test-"));
  try {
    const f = fixture(directory);
    f.setProcessing(true);
    await f.run();
    assert.deepEqual(fs.readdirSync(directory), []);
    f.setProcessing(false);
    await f.run();
    assert.equal(
      fs.readFileSync(path.join(directory, "t3code-android-internal-2.0.0-41.apk"), "utf8"),
      "signed APK",
    );
    assert.deepEqual(f.calls, []);
    assert(f.tracks.every((track) => track === "internal"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
