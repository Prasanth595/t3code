"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const configPluginsRequire = createRequire(require.resolve("expo/config-plugins"));
const xcode = configPluginsRequire("xcode");
const {
  addWatchCompanionTarget,
  SOURCE_FILES,
  TARGET_NAME,
} = require("./watchCompanionTarget.cjs");
const withWatchCompanion = require("../withWatchCompanion.cjs");
const { writeWatchSources } = withWatchCompanion;

function fixture() {
  const project = xcode.project("unused.pbxproj");
  project.hash = { project: { objects: {} } };
  const ids = {};
  for (const key of [
    "project",
    "main",
    "products",
    "app",
    "configList",
    "debug",
    "release",
    "extension",
  ])
    ids[key] = project.generateUuid();
  const hostSettings = {
    SDKROOT: "iphoneos",
    DEVELOPMENT_TEAM: "TESTTEAM",
    CODE_SIGN_STYLE: "Automatic",
    CODE_SIGN_ENTITLEMENTS: "App/App.entitlements",
    PRODUCT_BUNDLE_IDENTIFIER: '"codes.t3.app"',
  };
  project.hash = {
    project: {
      archiveVersion: 1,
      classes: {},
      objectVersion: 54,
      rootObject: ids.project,
      objects: {
        PBXProject: {
          [ids.project]: {
            isa: "PBXProject",
            mainGroup: ids.main,
            productRefGroup: ids.products,
            targets: [
              { value: ids.app, comment: "App" },
              { value: ids.extension, comment: "ShareExtension" },
            ],
            attributes: {
              TargetAttributes: {
                [ids.app]: { DevelopmentTeam: "TESTTEAM", ProvisioningStyle: "Automatic" },
              },
            },
          },
        },
        PBXGroup: {
          [ids.main]: { isa: "PBXGroup", children: [], sourceTree: '"<group>"' },
          [ids.products]: {
            isa: "PBXGroup",
            name: "Products",
            children: [],
            sourceTree: '"<group>"',
          },
        },
        PBXNativeTarget: {
          [ids.app]: {
            isa: "PBXNativeTarget",
            name: "App",
            productType: '"com.apple.product-type.application"',
            buildConfigurationList: ids.configList,
            buildPhases: [],
            dependencies: [],
          },
          [ids.extension]: {
            isa: "PBXNativeTarget",
            name: "ShareExtension",
            productType: '"com.apple.product-type.app-extension"',
            buildPhases: [{ value: "unrelated", comment: "Existing phase" }],
            dependencies: [],
          },
        },
        XCConfigurationList: {
          [ids.configList]: {
            isa: "XCConfigurationList",
            buildConfigurations: [
              { value: ids.debug, comment: "Debug" },
              { value: ids.release, comment: "Release" },
            ],
          },
        },
        XCBuildConfiguration: {
          [ids.debug]: {
            isa: "XCBuildConfiguration",
            name: "Debug",
            buildSettings: { ...hostSettings },
          },
          [ids.release]: {
            isa: "XCBuildConfiguration",
            name: "Release",
            buildSettings: { ...hostSettings },
          },
        },
      },
    },
  };
  return { project, ids };
}

test("Watch target graph survives real PBX serialization and repeated prebuild without touching extensions", () => {
  const { project, ids } = fixture();
  const objects = project.hash.project.objects;
  const extensionBefore = JSON.stringify(objects.PBXNativeTarget[ids.extension]);
  const targetId = addWatchCompanionTarget(project, "codes.t3.app");
  const serialized = project.writeSync();
  assert.equal(addWatchCompanionTarget(project, "codes.t3.app"), targetId);
  assert.equal(project.writeSync(), serialized);
  assert.equal(JSON.stringify(objects.PBXNativeTarget[ids.extension]), extensionBefore);
  const target = objects.PBXNativeTarget[targetId];
  assert.equal(target.productType, '"com.apple.product-type.application"');
  const list = objects.XCConfigurationList[target.buildConfigurationList];
  for (const { value } of list.buildConfigurations) {
    const settings = objects.XCBuildConfiguration[value].buildSettings;
    assert.equal(settings.ARCHS, '"$(ARCHS_STANDARD)"');
    assert.equal(settings.SDKROOT, "watchos");
    assert.equal(settings.WATCHOS_DEPLOYMENT_TARGET, "10.0");
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, '"codes.t3.app.watchkitapp"');
    assert.equal(settings.DEVELOPMENT_TEAM, "TESTTEAM");
    assert.equal(settings.CODE_SIGN_STYLE, "Automatic");
    assert.equal(settings.CODE_SIGN_ENTITLEMENTS, undefined);
    assert.equal(settings.CURRENT_PROJECT_VERSION, '"1"');
    assert.equal(settings.MARKETING_VERSION, '"1.0"');
  }
  assert.equal(objects.PBXNativeTarget[ids.app].dependencies.length, 1);
  const dependency =
    objects.PBXTargetDependency[objects.PBXNativeTarget[ids.app].dependencies[0].value];
  assert.equal(dependency.target, targetId);
  const embed = Object.values(objects.PBXCopyFilesBuildPhase).find((value) => value?.isa);
  assert.equal(embed.dstPath, '"$(CONTENTS_FOLDER_PATH)/Watch"');
  assert.equal(embed.dstSubfolderSpec, 16);
  const sources = objects.PBXSourcesBuildPhase[target.buildPhases[0].value];
  assert.equal(sources.files.length, SOURCE_FILES.length);
  const resources = target.buildPhases
    .map(({ value }) => objects.PBXResourcesBuildPhase?.[value])
    .filter(Boolean);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].files.length, 1);
  const assetBuildFile = objects.PBXBuildFile[resources[0].files[0].value];
  assert.equal(objects.PBXFileReference[assetBuildFile.fileRef].path, "Assets.xcassets");
  for (const { value } of list.buildConfigurations) {
    assert.equal(
      objects.XCBuildConfiguration[value].buildSettings.ASSETCATALOG_COMPILER_APPICON_NAME,
      "AppIcon",
    );
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-watch-pbx-"));
  try {
    const file = path.join(directory, "project.pbxproj");
    fs.writeFileSync(file, serialized);
    const parsed = xcode.project(file);
    parsed.parseSync();
    addWatchCompanionTarget(parsed, "codes.t3.changed", { version: "2.3.4", buildNumber: "27" });
    const parsedTarget = parsed.hash.project.objects.PBXNativeTarget[targetId];
    const configuration =
      parsed.hash.project.objects.XCConfigurationList[parsedTarget.buildConfigurationList]
        .buildConfigurations[0].value;
    assert.equal(
      parsed.hash.project.objects.XCBuildConfiguration[configuration].buildSettings
        .PRODUCT_BUNDLE_IDENTIFIER,
      '"codes.t3.changed.watchkitapp"',
    );
    assert.equal(parsed.hash.project.objects.PBXNativeTarget[ids.app].dependencies.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Watch source generation is clean-build complete, idempotent, and uses a modern single target plist", async () => {
  const config = withWatchCompanion({ ios: { bundleIdentifier: "codes.t3.app" } });
  const host = await config.mods.ios.infoPlist({
    ...config,
    modResults: { ExistingHostSetting: "preserved" },
    modRequest: { platform: "ios", modName: "infoPlist" },
  });
  assert.equal(host.modResults.T3WatchCompanionEnabled, true);
  assert.equal(host.modResults.ExistingHostSetting, "preserved");
  const mobileRoot = path.resolve(__dirname, "../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-watch-files-"));
  try {
    writeWatchSources(mobileRoot, directory, "codes.t3.app");
    const destination = path.join(directory, TARGET_NAME);
    const before = fs.readFileSync(path.join(destination, "Info.plist"), "utf8");
    writeWatchSources(mobileRoot, directory, "codes.t3.app");
    assert.equal(fs.readFileSync(path.join(destination, "Info.plist"), "utf8"), before);
    assert.match(before, /<key>WKApplication<\/key><true\/>/);
    assert.match(before, /<key>CFBundleDisplayName<\/key><string>T3 Code<\/string>/);
    const wordmarkDirectory = path.join(destination, "Assets.xcassets", "T3Wordmark.imageset");
    const wordmark = fs.readFileSync(path.join(wordmarkDirectory, "T3Wordmark.svg"), "utf8");
    const phoneWordmark = fs.readFileSync(
      path.join(mobileRoot, "src/components/T3Wordmark.tsx"),
      "utf8",
    );
    assert.ok(wordmark.includes(phoneWordmark.match(/d="([^"]+)"/)[1]));
    assert.match(wordmark, /viewBox="15.5309 37 94.3941 56.96"/);
    const wordmarkContents = JSON.parse(
      fs.readFileSync(path.join(wordmarkDirectory, "Contents.json"), "utf8"),
    );
    assert.equal(wordmarkContents.properties["preserves-vector-representation"], true);
    const iconDirectory = path.join(destination, "Assets.xcassets", "AppIcon.appiconset");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(iconDirectory, "Contents.json"), "utf8")).images,
      [{ filename: "AppIcon.png", idiom: "universal", platform: "watchos", size: "1024x1024" }],
    );
    assert.deepEqual(
      fs.readFileSync(path.join(iconDirectory, "AppIcon.png")),
      fs.readFileSync(path.resolve(mobileRoot, "../../assets/prod/black-ios-1024.png")),
    );
    writeWatchSources(
      mobileRoot,
      directory,
      "codes.t3.app",
      "../../assets/dev/blueprint-ios-1024.png",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(iconDirectory, "AppIcon.png")),
      fs.readFileSync(path.resolve(mobileRoot, "../../assets/dev/blueprint-ios-1024.png")),
    );
    assert.match(
      before,
      /<key>WKCompanionAppBundleIdentifier<\/key><string>codes.t3.app<\/string>/,
    );
    assert.match(before, /<key>UIBackgroundModes<\/key><array><string>audio<\/string>/);
    assert.doesNotMatch(before, /NSExtension|WKWatchKitApp/);
    for (const file of SOURCE_FILES) assert.ok(fs.statSync(path.join(destination, file)).size > 0);
    if (os.platform() === "darwin")
      execFileSync("/usr/bin/plutil", ["-lint", path.join(destination, "Info.plist")]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid companion identity and incompatible existing targets fail explicitly", () => {
  const { project } = fixture();
  assert.throws(() => addWatchCompanionTarget(project, "$(PRODUCT_BUNDLE_IDENTIFIER)"), /concrete/);
  const target = addWatchCompanionTarget(project, "codes.t3.app");
  project.hash.project.objects.PBXNativeTarget[target].productType =
    '"com.apple.product-type.app-extension"';
  assert.throws(() => addWatchCompanionTarget(project, "codes.t3.app"), /incompatible/);
});
