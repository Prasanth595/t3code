// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(
  import.meta.dirname,
  "../../../../factory/scripts/mobile-preflight.sh",
);

const NAMES = [
  "APPLE_TEAM_ID",
  "IOS_DIST_CERT_P12",
  "IOS_DIST_CERT_PASSWORD",
  "IOS_APP_PROFILE",
  "IOS_WIDGETS_PROFILE",
  "IOS_SHARING_PROFILE",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

const PROFILES = ["IOS_APP_PROFILE", "IOS_WIDGETS_PROFILE", "IOS_SHARING_PROFILE"] as const;
type Profile = (typeof PROFILES)[number];

const TEAM = "3TB6CJ6ZHV";
const APP_ID = "au.com.originalsolutions.t3codefactory";
const GROUP = `group.${APP_ID}`;
const BUNDLE_IDS: Record<Profile, string> = {
  IOS_APP_PROFILE: APP_ID,
  IOS_WIDGETS_PROFILE: `${APP_ID}.widgets`,
  IOS_SHARING_PROFILE: `${APP_ID}.sharing`,
};

// Valid base64, so the script decodes it and goes on to the checks that echo values.
const SECRET = Buffer.from("secret-value-that-must-never-print").toString("base64");

// A stand-in for a decoded profile: `key=value` for a scalar, `key[]=value` per array
// item. The security stub hands it back as the decoded plist, and the PlistBuddy and
// plutil stubs answer from it the way the real tools answer from a profile.
type Fields = Record<string, string | readonly string[] | undefined>;

const profileFields = (profile: Profile): Fields => ({
  TeamIdentifier: [TEAM],
  ExpirationDate: "2099-01-01T00:00:00Z",
  "Entitlements:application-identifier": `${TEAM}.${BUNDLE_IDS[profile]}`,
  "Entitlements:get-task-allow": "false",
  "Entitlements:com.apple.security.application-groups": [GROUP],
  ...(profile === "IOS_APP_PROFILE"
    ? {
        "Entitlements:aps-environment": "production",
        "Entitlements:com.apple.developer.associated-domains": "*",
        "Entitlements:com.apple.developer.applesignin": ["Default"],
      }
    : {}),
});

const encodeProfile = (fields: Fields) =>
  Buffer.from(
    Object.entries(fields)
      .flatMap(([key, value]) =>
        value === undefined
          ? []
          : typeof value === "string"
            ? [`${key}=${value}`]
            : value.map((item) => `${key}[]=${item}`),
      )
      .join("\n") + "\n",
  ).toString("base64");

const STUBS = {
  security: `case "$1" in
  create-keychain|delete-keychain) exit 0 ;;
  import) [[ -z "\${STUB_IMPORT_FAILS:-}" ]] ;;
  find-identity)
    echo "  1) ABCDEF \\"$STUB_IDENTITY\\""
    for i in $(seq 2 3000); do echo "  $i) 0123456789ABCDEF \\"Apple Development: Someone Else (BBBBBBBBBB)\\""; done
    echo "     3000 valid identities found" ;;
  cms) grep -q = "$4" && cat "$4" ;;
esac`,
  PlistBuddy: `key=\${2#Print :}
file=$3
if grep -q "^$key\\[\\]=" "$file"; then
  echo "Array {"
  grep "^$key\\[\\]=" "$file" | cut -d= -f2- | sed 's/^/    /'
  echo "}"
elif grep -q "^$key=" "$file"; then
  grep "^$key=" "$file" | cut -d= -f2-
else
  echo "Print: Entry, \\":$key\\", Does Not Exist" >&2
  exit 1
fi`,
  plutil: `set -o pipefail; grep "^$2=" "\${@: -1}" | cut -d= -f2-`,
};

const ALL_SET = {
  APPLE_TEAM_ID: TEAM,
  IOS_DIST_CERT_P12: SECRET,
  IOS_DIST_CERT_PASSWORD: SECRET,
  IOS_APP_PROFILE: encodeProfile(profileFields("IOS_APP_PROFILE")),
  IOS_WIDGETS_PROFILE: encodeProfile(profileFields("IOS_WIDGETS_PROFILE")),
  IOS_SHARING_PROFILE: encodeProfile(profileFields("IOS_SHARING_PROFILE")),
  APPLE_API_KEY: SECRET,
  APPLE_API_KEY_ID: "KEYID12345",
  APPLE_API_ISSUER: SECRET,
};

let temp: string;
let stubs: string;

beforeAll(() => {
  temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-preflight-"));
  stubs = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-preflight-stubs-"));
  for (const [name, body] of Object.entries(STUBS)) {
    NodeFS.writeFileSync(NodePath.join(stubs, name), `#!/usr/bin/env bash\n${body}\n`, {
      mode: 0o755,
    });
  }
});

afterAll(() => {
  NodeFS.rmSync(temp, { recursive: true, force: true });
  NodeFS.rmSync(stubs, { recursive: true, force: true });
});

// Only PATH and RUNNER_TEMP from outside, so a developer's own signing variables never leak in.
const preflight = (values: Partial<Record<(typeof NAMES)[number], string>>) => {
  const result = NodeChildProcess.spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: temp, ...values },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const stubbed = (values: Record<string, string> = {}) => {
  const result = NodeChildProcess.spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      PLISTBUDDY: NodePath.join(stubs, "PlistBuddy"),
      RUNNER_TEMP: temp,
      STUB_IDENTITY: `Apple Distribution: Original Solutions (${TEAM})`,
      ...ALL_SET,
      ...values,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const withProfile = (profile: Profile, change: Fields) => ({
  [profile]: encodeProfile({ ...profileFields(profile), ...change }),
});

const expectFailure = (result: { status: number | null; output: string }, error: string) => {
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain("::error::");
  expect(result.output).toContain(error);
  expect(result.output).not.toContain(SECRET);
};

describe("mobile-preflight.sh", () => {
  it("names every missing value and stops before touching anything", () => {
    const result = preflight({});
    expect(result.status).toBe(1);
    for (const name of NAMES) expect(result.output).toContain(name);
    expect(NodeFS.readdirSync(temp)).toEqual([]);
  });

  it("names only the values that are missing", () => {
    const result = preflight({ ...ALL_SET, IOS_SHARING_PROFILE: "", APPLE_API_ISSUER: "" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("IOS_SHARING_PROFILE");
    expect(result.output).toContain("APPLE_API_ISSUER");
    expect(result.output).not.toMatch(/\bIOS_APP_PROFILE\b/);
    expect(result.output).not.toContain(SECRET);
  });

  it("passes every check when the values are right, printing none of them", () => {
    const result = stubbed();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`ok: Apple Distribution identity for team ${TEAM}`);
    for (const profile of PROFILES) {
      expect(result.output).toContain(`ok: ${profile} is an App Store profile for ${TEAM}.`);
    }
    expect(result.output).not.toContain(SECRET);
  });

  it("accepts the older iPhone Distribution name for the certificate", () => {
    const result = stubbed({ STUB_IDENTITY: `iPhone Distribution: Original Solutions (${TEAM})` });
    expect(result.status, result.output).toBe(0);
  });

  it("rejects a certificate its password does not open", () => {
    expectFailure(
      stubbed({ STUB_IMPORT_FAILS: "1" }),
      "IOS_DIST_CERT_P12 is not a .p12 that IOS_DIST_CERT_PASSWORD opens",
    );
  });

  it("rejects a certificate for another team", () => {
    expectFailure(
      stubbed({ STUB_IDENTITY: "Apple Distribution: Someone Else (AAAAAAAAAA)" }),
      `IOS_DIST_CERT_P12 holds no valid Apple Distribution identity for team ${TEAM}`,
    );
  });

  it("rejects a value that is not a provisioning profile", () => {
    expectFailure(
      stubbed({ IOS_WIDGETS_PROFILE: Buffer.from("garbage").toString("base64") }),
      "IOS_WIDGETS_PROFILE is not a provisioning profile",
    );
  });

  it.each(PROFILES)("checks the team and bundle id of %s", (profile) => {
    expectFailure(
      stubbed(withProfile(profile, { TeamIdentifier: ["AAAAAAAAAA"] })),
      `${profile} is not for team ${TEAM}`,
    );
    expectFailure(
      stubbed(withProfile(profile, { "Entitlements:application-identifier": `${TEAM}.x.y` })),
      `${profile} is for ${TEAM}.x.y, not ${TEAM}.${BUNDLE_IDS[profile]}`,
    );
  });

  it.each(PROFILES)("rejects %s when it is not an App Store profile", (profile) => {
    expectFailure(
      stubbed(withProfile(profile, { ProvisionedDevices: ["00008110-000000000000001E"] })),
      `${profile} is not an App Store profile`,
    );
    expectFailure(
      stubbed(withProfile(profile, { ProvisionsAllDevices: "true" })),
      `${profile} is not an App Store profile`,
    );
    expectFailure(
      stubbed(withProfile(profile, { "Entitlements:get-task-allow": "true" })),
      `${profile} is not an App Store profile`,
    );
  });

  it.each(PROFILES)("requires the App Group in %s", (profile) => {
    expectFailure(
      stubbed(withProfile(profile, { "Entitlements:com.apple.security.application-groups": [] })),
      `${profile} does not grant App Group ${GROUP}`,
    );
    expectFailure(
      stubbed(
        withProfile(profile, {
          "Entitlements:com.apple.security.application-groups": ["group.other"],
        }),
      ),
      `${profile} does not grant App Group ${GROUP}`,
    );
  });

  it.each([
    ["aps-environment", "Push Notifications (aps-environment)"],
    ["com.apple.developer.associated-domains", "Associated Domains"],
    ["com.apple.developer.applesignin", "Sign in with Apple"],
  ])("requires %s in the app profile", (entitlement, label) => {
    expectFailure(
      stubbed(withProfile("IOS_APP_PROFILE", { [`Entitlements:${entitlement}`]: undefined })),
      `IOS_APP_PROFILE does not grant ${label}`,
    );
  });

  it.each(["IOS_DIST_CERT_P12", ...PROFILES])("names %s when it is not base64", (name) => {
    expectFailure(stubbed({ [name]: "%%%%" }), `${name} is not base64`);
  });

  it("names a profile with no expiration date", () => {
    expectFailure(
      stubbed(withProfile("IOS_WIDGETS_PROFILE", { ExpirationDate: undefined })),
      "IOS_WIDGETS_PROFILE has no expiration date",
    );
  });

  it("rejects an expired profile", () => {
    expectFailure(
      stubbed(withProfile("IOS_SHARING_PROFILE", { ExpirationDate: "2020-01-01T00:00:00Z" })),
      "IOS_SHARING_PROFILE expired on 2020-01-01T00:00:00Z",
    );
  });
});
