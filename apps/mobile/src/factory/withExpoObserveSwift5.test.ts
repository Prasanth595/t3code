import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const { addExpoObserveSwift5 } = NodeModule.createRequire(import.meta.url)(
  "./withExpoObserveSwift5.cjs",
) as { addExpoObserveSwift5: (podfile: string) => string };

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

  it("adds the setting once when prebuild runs again", () => {
    const once = addExpoObserveSwift5(PODFILE);

    expect(addExpoObserveSwift5(once)).toBe(once);
  });

  it("fails the prebuild when the Podfile has no post_install hook", () => {
    expect(() => addExpoObserveSwift5("target 'T3CodeFactory' do\nend\n")).toThrow(/post_install/);
  });
});
