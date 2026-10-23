// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const repo = NodePath.resolve(import.meta.dirname, "../../../..");
const script = NodePath.join(repo, "factory/scripts/mobile-sign-project.ts");

const APP_ID = "au.com.originalsolutions.t3codefactory";

// The build configurations a production prebuild writes, cut down to the settings
// signing touches: the app (automatic by default), the widgets, the share extension
// (automatic, said outright) and the project level, which has no bundle id.
const config = (id: string, name: string, settings: string) => `\t\t${id} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${settings}
\t\t\t};
\t\t\tname = ${name};
\t\t};`;

const target = (bundleId: string, extra = "") =>
  `\t\t\t\tDEVELOPMENT_TEAM = 3TB6CJ6ZHV;\n${extra}\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";`;

const PBXPROJ = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 54;
\tobjects = {

/* Begin XCBuildConfiguration section */
${config("A1", "Debug", target(APP_ID))}
${config("A2", "Release", target(APP_ID))}
${config("B1", "Debug", target(`${APP_ID}.widgets`))}
${config("B2", "Release", target(`${APP_ID}.widgets`))}
${config("C1", "Debug", target(`${APP_ID}.sharing`, "\t\t\t\tCODE_SIGN_STYLE = Automatic;\n"))}
${config("C2", "Release", target(`${APP_ID}.sharing`, "\t\t\t\tCODE_SIGN_STYLE = Automatic;\n"))}
${config("P1", "Release", '\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";')}
/* End XCBuildConfiguration section */
\t};
\trootObject = A1;
}
`;

const PROFILES = [
  `${APP_ID}=Factory App Store`,
  `${APP_ID}.widgets=Factory Widgets App Store`,
  `${APP_ID}.sharing=Factory Sharing App Store`,
];

const requireFromMobile = NodeModule.createRequire(NodePath.join(repo, "apps/mobile/package.json"));
const { IOSConfig } = requireFromMobile("expo/config-plugins") as {
  IOSConfig: {
    XcodeUtils: {
      getPbxproj: (projectRoot: string) => {
        pbxXCBuildConfigurationSection: () => Record<
          string,
          { buildSettings?: Record<string, string> } | string
        >;
      };
    };
  };
};

let root: string;
let pbxproj: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-sign-"));
  const project = NodePath.join(root, "ios", "T3CodeFactory.xcodeproj");
  NodeFS.mkdirSync(project, { recursive: true });
  pbxproj = NodePath.join(project, "project.pbxproj");
  NodeFS.writeFileSync(pbxproj, PBXPROJ);
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const sign = (...args: string[]) => {
  const result = NodeChildProcess.spawnSync("node", [script, root, "3TB6CJ6ZHV", ...args], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const settingsById = () => {
  const section = IOSConfig.XcodeUtils.getPbxproj(root).pbxXCBuildConfigurationSection();
  return Object.fromEntries(
    Object.entries(section).flatMap(([id, value]) =>
      typeof value === "object" && value.buildSettings ? [[id, value.buildSettings]] : [],
    ),
  );
};

describe("mobile-sign-project.ts", () => {
  it("signs every target manually with the profile for its bundle id", () => {
    const result = sign(...PROFILES);
    expect(result.status, result.output).toBe(0);

    const settings = settingsById();
    const expectSigned = (ids: string[], profile: string) => {
      for (const id of ids) {
        expect(settings[id]).toMatchObject({
          CODE_SIGN_STYLE: "Manual",
          DEVELOPMENT_TEAM: "3TB6CJ6ZHV",
          CODE_SIGN_IDENTITY: '"Apple Distribution"',
          PROVISIONING_PROFILE_SPECIFIER: `"${profile}"`,
        });
      }
    };
    expectSigned(["A1", "A2"], "Factory App Store");
    expectSigned(["B1", "B2"], "Factory Widgets App Store");
    expectSigned(["C1", "C2"], "Factory Sharing App Store");
    expect(settings.P1).toEqual({ '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"': '"iPhone Developer"' });
  });

  it("fails, naming it, when a signed target has no profile", () => {
    const result = sign(PROFILES[0]!, PROFILES[1]!);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`No profile for ${APP_ID}.sharing`);
    expect(NodeFS.readFileSync(pbxproj, "utf8")).toBe(PBXPROJ);
  });

  it("fails, naming it, when a profile matches no target", () => {
    const result = sign(...PROFILES, "com.example.other=Other");
    expect(result.status).toBe(1);
    expect(result.output).toContain("No target has bundle id com.example.other");
    expect(NodeFS.readFileSync(pbxproj, "utf8")).toBe(PBXPROJ);
  });
});
