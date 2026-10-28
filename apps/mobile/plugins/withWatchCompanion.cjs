"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withInfoPlist, withXcodeProject } = require("expo/config-plugins");
const { addWatchCompanionTarget, TARGET_NAME } = require("./lib/watchCompanionTarget.cjs");

function writeWatchSources(
  projectRoot,
  platformRoot,
  bundleIdentifier,
  iconPath = "../../assets/prod/black-ios-1024.png",
) {
  const destination = path.join(platformRoot, TARGET_NAME);
  fs.mkdirSync(destination, { recursive: true });
  for (const [directory, names] of [
    ["watch", ["T3WatchApp.swift", "WatchModel.swift", "WatchViews.swift"]],
    ["modules/t3-watch-bridge/ios/Shared", ["WatchContract.swift", "RecordingStore.swift"]],
  ]) {
    for (const name of names)
      fs.copyFileSync(path.join(projectRoot, directory, name), path.join(destination, name));
  }
  const catalog = path.join(destination, "Assets.xcassets");
  const appIcon = path.join(catalog, "AppIcon.appiconset");
  fs.mkdirSync(appIcon, { recursive: true });
  fs.copyFileSync(path.resolve(projectRoot, iconPath), path.join(appIcon, "AppIcon.png"));
  fs.writeFileSync(
    path.join(catalog, "Contents.json"),
    JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2),
  );
  fs.writeFileSync(
    path.join(appIcon, "Contents.json"),
    JSON.stringify(
      {
        images: [
          { filename: "AppIcon.png", idiom: "universal", platform: "watchos", size: "1024x1024" },
        ],
        info: { author: "xcode", version: 1 },
      },
      null,
      2,
    ),
  );
  const brandSvg = fs.readFileSync(path.resolve(projectRoot, "../../assets/prod/logo.svg"), "utf8");
  const wordmarkPath = brandSvg.match(/<path d="([^"]+)" fill="white"\s*\/>/)?.[1];
  if (!wordmarkPath) throw new Error("Watch heading requires the shared T3 wordmark path");
  const wordmark = path.join(catalog, "T3Wordmark.imageset");
  fs.mkdirSync(wordmark, { recursive: true });
  fs.writeFileSync(
    path.join(wordmark, "T3Wordmark.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="94.3941" height="56.96" viewBox="15.5309 37 94.3941 56.96"><path d="${wordmarkPath}" fill="black"/></svg>\n`,
  );
  fs.writeFileSync(
    path.join(wordmark, "Contents.json"),
    JSON.stringify(
      {
        images: [{ filename: "T3Wordmark.svg", idiom: "universal" }],
        info: { author: "xcode", version: 1 },
        properties: {
          "preserves-vector-representation": true,
          "template-rendering-intent": "template",
        },
      },
      null,
      2,
    ),
  );
  const escape = (value) =>
    String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  fs.writeFileSync(
    path.join(destination, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>T3 Code</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>WKApplication</key><true/>
<key>WKCompanionAppBundleIdentifier</key><string>${escape(bundleIdentifier)}</string>
<key>WKRunsIndependentlyOfCompanionApp</key><false/>
<key>NSMicrophoneUsageDescription</key><string>Record a new T3 thread or a reply for review on your iPhone.</string>
<key>UIBackgroundModes</key><array><string>audio</string></array>
</dict></plist>
`,
  );
}

module.exports = function withWatchCompanion(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) throw new Error("withWatchCompanion requires ios.bundleIdentifier");
  config = withInfoPlist(config, (mod) => {
    mod.modResults.T3WatchCompanionEnabled = true;
    return mod;
  });
  config = withDangerousMod(config, [
    "ios",
    (mod) => {
      writeWatchSources(
        mod.modRequest.projectRoot,
        mod.modRequest.platformProjectRoot,
        bundleIdentifier,
        config.icon,
      );
      return mod;
    },
  ]);
  return withXcodeProject(config, (mod) => {
    addWatchCompanionTarget(mod.modResults, bundleIdentifier, {
      version: config.version,
      buildNumber: config.ios?.buildNumber,
    });
    return mod;
  });
};
module.exports.writeWatchSources = writeWatchSources;
