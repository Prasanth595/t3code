const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const test = require("node:test");
const source =
  fs.readFileSync(path.join(__dirname, "mirror-play-apk.cjs"), "utf8").split("main().catch(")[0] +
  "\nglobalThis.archive = archiveRelease;";
test("APK snapshots resume interrupted uploads, deduplicate unchanged sets, and retain history", () => {
  let release;
  let failUpload = false;
  const calls = [];
  const context = {
    require(name) {
      if (name === "node:child_process")
        return {
          execFileSync(_, args) {
            calls.push(args);
            if (args[1] === "view") {
              if (!release) throw Error("missing");
              return JSON.stringify(release);
            }
            if (args[1] === "create") release = { assets: [], body: "", isDraft: true };
            if (args[1] === "upload" && failUpload) {
              failUpload = false;
              throw Error("interrupted");
            }
            if (args[1] === "edit") release.isDraft = false;
            return "";
          },
        };
      return require(name);
    },
    console,
    process,
    Buffer,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const assets = [
    { name: "t3code-android-beta-2.0.0-41.apk" },
    { name: "t3code-android-internal-2.0.0-42.apk" },
  ];
  failUpload = true;
  assert.throws(
    () => context.archive("android-nightly", assets, "/releases/download/android-nightly/test"),
    /interrupted/,
  );
  assert.equal(release.isDraft, true);
  context.archive("android-nightly", assets, "/releases/download/android-nightly/test");
  assert.equal(release.isDraft, false);
  assert.equal(calls.filter((x) => x[1] === "create").length, 1);
  const count = calls.length;
  context.archive("android-nightly", assets, "/releases/download/android-nightly/test");
  assert.equal(calls.length, count + 1);
  const firstTag = calls.find((x) => x[1] === "create")[2];
  release = undefined;
  context.archive(
    "android-nightly",
    [assets[0], { name: "t3code-android-internal-2.0.0-43.apk" }],
    "notes",
  );
  assert.notEqual(calls.findLast((x) => x[1] === "create")[2], firstTag);
  assert.equal(calls.filter((x) => x[1] === "delete" || x[1] === "delete-asset").length, 0);
});
