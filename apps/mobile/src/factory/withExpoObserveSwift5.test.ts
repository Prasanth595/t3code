import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExportedConfig, ExportedConfigWithProps } from "expo/config-plugins";
import { describe, expect, it } from "vite-plus/test";

import withExpoObserveSwift5, { addExpoObserveSwift5 } from "./withExpoObserveSwift5.cjs";

const PODFILE = `target 'T3CodeFactory' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(installer, config[:reactNativePath])
  end
end
`;

describe("withExpoObserveSwift5", () => {
  it("sets Swift 5 on the ExpoObserve pod target only, inside post_install", () => {
    const podfile = addExpoObserveSwift5(PODFILE);

    const postInstall = podfile.slice(podfile.indexOf("post_install do |installer|"));
    expect(postInstall).toContain('next unless target.name == "ExpoObserve"');
    expect(postInstall).toContain('build_settings["SWIFT_VERSION"] = "5.0"');
    expect(podfile.replace(/ *# t3code-factory:[\s\S]*?\n    end\n/, "")).toBe(PODFILE);
  });

  it("rewrites the generated ios/Podfile during prebuild", async () => {
    const iosRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "expo-observe-swift5-"));
    try {
      NodeFS.writeFileSync(NodePath.join(iosRoot, "Podfile"), PODFILE);
      const config: ExportedConfig = withExpoObserveSwift5({
        name: "T3 Code Factory",
        slug: "t3-code-factory",
      });

      await config.mods?.ios?.dangerous?.({
        ...config,
        modRequest: { platformProjectRoot: iosRoot },
      } as ExportedConfigWithProps<unknown>);

      expect(NodeFS.readFileSync(NodePath.join(iosRoot, "Podfile"), "utf8")).toBe(
        addExpoObserveSwift5(PODFILE),
      );
    } finally {
      NodeFS.rmSync(iosRoot, { recursive: true, force: true });
    }
  });

  it("adds the setting once when prebuild runs again", () => {
    const once = addExpoObserveSwift5(PODFILE);

    expect(addExpoObserveSwift5(once)).toBe(once);
  });

  it("fails the prebuild when the Podfile has no post_install hook", () => {
    expect(() => addExpoObserveSwift5("target 'T3CodeFactory' do\nend\n")).toThrow(/post_install/);
  });
});
