import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (
  process.env.EXPO_PUBLIC_CHIP_EVIDENCE !== "1" ||
  process.env.EAS_BUILD_PROFILE !== "chip-evidence" ||
  process.env.EAS_BUILD_PLATFORM !== "ios"
) {
  process.exit(0);
}

const iosRoot = NodeURL.fileURLToPath(new URL("../ios/", import.meta.url));
const projects = NodeFS.readdirSync(iosRoot)
  .filter((name) => name.endsWith(".xcodeproj"))
  .map((name) => NodePath.join(iosRoot, name));
projects.push(NodePath.join(iosRoot, "Pods/Pods.xcodeproj"));
if (projects.length < 2 || projects.some((project) => !NodeFS.existsSync(project))) {
  throw new Error("Chip evidence requires generated app and Pods Xcode projects.");
}

// GhosttyKit vendors an arm64 simulator slice. The generic EAS Release destination
// otherwise builds x86_64 too, unlike the repository's local showcase recipe.
NodeChildProcess.execFileSync(
  "ruby",
  [
    "-e",
    `require 'xcodeproj'
ARGV.each do |path|
  project = Xcodeproj::Project.open(path)
  configurations = project.build_configurations + project.targets.flat_map(&:build_configurations)
  configurations.each do |configuration|
    configuration.build_settings['ARCHS'] = 'arm64'
    configuration.build_settings['ONLY_ACTIVE_ARCH'] = 'YES'
    configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'x86_64'
  end
  project.save
  puts "Chip evidence: arm64 simulator settings applied to #{path}"
end`,
    ...projects,
  ],
  { stdio: "inherit" },
);
