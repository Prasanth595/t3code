const assert = require("node:assert/strict");
const test = require("node:test");
const { planSplitApkSets } = require("./mirror-play-apk.cjs");

const split = (downloadId, splitId, targeting = {}) => ({
  path: `${downloadId}.apk`,
  splitApkMetadata: { splitId, isMasterSplit: splitId === "" },
  targeting,
});
const abi = (alias) => ({ abiTargeting: { value: [{ alias }] } });

function signingKey({ variants, extraSplits = [] }) {
  const ids = variants.flatMap(({ apkSet }) =>
    apkSet.flatMap(({ apkDescription }) => apkDescription.map(({ path }) => path.slice(0, -4))),
  );
  return {
    generatedUniversalApk: { downloadId: "universal" },
    generatedSplitApks: [...ids, ...extraSplits].map((downloadId) => ({ downloadId })),
    targetingInfo: { variant: variants },
  };
}

function variant(variantNumber, minSdk, prefix, extraModules = []) {
  return {
    variantNumber,
    targeting: { sdkVersionTargeting: { value: [{ min: minSdk }] } },
    apkSet: [
      {
        moduleMetadata: { name: "base", deliveryType: "INSTALL_TIME" },
        apkDescription: [
          split(`${prefix}-base`, ""),
          split(`${prefix}-arm64`, "config.arm64_v8a", abi("ARM64_V8A")),
          split(`${prefix}-armv7`, "config.armeabi_v7a", abi("ARMEABI_V7A")),
          split(`${prefix}-x86`, "config.x86", abi("X86")),
          split(`${prefix}-x86_64`, "config.x86_64", abi("X86_64")),
          split(`${prefix}-xxhdpi`, "config.xxhdpi", {
            screenDensityTargeting: { value: [{ densityAlias: "XXHDPI" }] },
          }),
          split(`${prefix}-en`, "config.en", { languageTargeting: { value: ["en"] } }),
        ],
      },
      ...extraModules,
    ],
  };
}

test("builds one set per ABI from the lowest-SDK variant", () => {
  const sets = planSplitApkSets(
    signingKey({ variants: [variant(1, 31, "v31"), variant(0, 24, "v24")] }),
    "com.example.app",
  );
  assert.deepEqual(
    sets.map(({ abi }) => abi),
    ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"],
  );
  assert.deepEqual(sets[0].pieces, [
    { downloadId: "v24-base", fileName: "com.example.app.apk" },
    { downloadId: "v24-xxhdpi", fileName: "split_config.xxhdpi.apk" },
    { downloadId: "v24-en", fileName: "split_config.en.apk" },
    { downloadId: "v24-arm64", fileName: "split_config.arm64_v8a.apk" },
  ]);
});

test("names only the base APK after the package, so Obtainium installs it first", () => {
  const [set] = planSplitApkSets(signingKey({ variants: [variant(0, 24, "v")] }), "com.x");
  assert.deepEqual(
    set.pieces
      .filter(({ fileName }) => fileName.startsWith("com.x"))
      .map(({ downloadId }) => downloadId),
    ["v-base"],
  );
});

test("leaves out modules that are not installed with the app", () => {
  const onDemand = {
    moduleMetadata: { name: "extras", deliveryType: "ON_DEMAND" },
    apkDescription: [split("extras", "extras")],
  };
  const sets = planSplitApkSets(
    signingKey({ variants: [variant(0, 24, "v", [onDemand])] }),
    "com.x",
  );
  assert.ok(sets.every(({ pieces }) => pieces.every(({ downloadId }) => downloadId !== "extras")));
});

test("returns no sets when Play generated no ABI splits", () => {
  const key = signingKey({ variants: [variant(0, 24, "v")] });
  key.targetingInfo.variant[0].apkSet[0].apkDescription = [split("v-base", "")];
  assert.deepEqual(planSplitApkSets(key, "com.x"), []);
  assert.deepEqual(planSplitApkSets({ generatedUniversalApk: {} }, "com.x"), []);
});

test("rejects targeting that points at an APK Play did not generate", () => {
  const key = signingKey({ variants: [variant(0, 24, "v")] });
  key.generatedSplitApks = key.generatedSplitApks.filter(({ downloadId }) => downloadId !== "v-en");
  assert.throws(() => planSplitApkSets(key, "com.x"), /v-en\.apk/);
});
