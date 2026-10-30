// Builds the ExpoObserve pod in Swift 5 language mode. expo-observe 58.0.16 hands
// expo-modules-core's `sending` event payload a value built from a stored property, which
// Swift 6.2 (Xcode 26.3) rejects as a data race; Swift 5 mode keeps it a warning. Only that
// pod target changes. Drop this plugin once an expo-observe release compiles under Swift 6.2.
const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# t3code-factory: ExpoObserve builds in Swift 5 language mode";
const POST_INSTALL = "post_install do |installer|\n";
const EXPO_OBSERVE_SWIFT_5 = `    ${MARKER}
    installer.pods_project.targets.each do |target|
      next unless target.name == "ExpoObserve"
      target.build_configurations.each do |build_configuration|
        build_configuration.build_settings["SWIFT_VERSION"] = "5.0"
      end
    end
`;

function addExpoObserveSwift5(podfile) {
  if (podfile.includes(MARKER)) return podfile;
  if (!podfile.includes(POST_INSTALL)) {
    throw new Error("Unable to build ExpoObserve in Swift 5 mode: post_install is missing.");
  }
  return podfile.replace(POST_INSTALL, `${POST_INSTALL}${EXPO_OBSERVE_SWIFT_5}`);
}

function withExpoObserveSwift5(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");
      fs.writeFileSync(podfilePath, addExpoObserveSwift5(podfile), "utf8");
      return nextConfig;
    },
  ]);
}

withExpoObserveSwift5.addExpoObserveSwift5 = addExpoObserveSwift5;
module.exports = withExpoObserveSwift5;
