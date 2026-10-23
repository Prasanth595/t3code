// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(
  import.meta.dirname,
  "../../../../factory/scripts/desktop-preflight.sh",
);

const NAMES = [
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "MACOS_PROVISIONING_PROFILE",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

// Valid base64, so the script decodes it and goes on to the checks that echo values.
const SECRET = Buffer.from("secret-value-that-must-never-print").toString("base64");

const TEAM = "3TB6CJ6ZHV";

// Stand-ins for the macOS tools, answering from STUB_* variables. find-identity lists
// more than a pipe holds after the match, as a keychain with many identities does, so
// a reader that stops at the first match makes it die of SIGPIPE every time, not by luck.
const STUBS = {
  security: `case "$1" in
  find-identity)
    echo "  1) ABCDEF \\"$STUB_IDENTITY\\""
    for i in $(seq 2 3000); do echo "  $i) 0123456789ABCDEF \\"Apple Development: Someone Else (BBBBBBBBBB)\\""; done
    echo "     3000 valid identities found" ;;
  cms) echo "<plist/>" ;;
esac`,
  PlistBuddy: `case "$2" in
  *application-identifier) echo "$STUB_APP_ID" ;;
  *associated-domains) [[ -n "\${STUB_DOMAINS:-}" ]] || exit 1; echo "Array {"; echo "}" ;;
esac`,
  plutil: `echo "$STUB_EXPIRES"`,
  xcrun: `exit 0`,
};

const VALID = {
  STUB_IDENTITY: `Developer ID Application: Original Solutions (${TEAM})`,
  STUB_APP_ID: `${TEAM}.io.github.original-solutions.t3code-factory`,
  STUB_DOMAINS: "1",
  STUB_EXPIRES: "2099-01-01T00:00:00Z",
};

const ALL_SET = {
  APPLE_TEAM_ID: TEAM,
  CSC_LINK: SECRET,
  CSC_KEY_PASSWORD: SECRET,
  MACOS_PROVISIONING_PROFILE: SECRET,
  APPLE_API_KEY: SECRET,
  APPLE_API_KEY_ID: "KEYID12345",
  APPLE_API_ISSUER: SECRET,
};

let temp: string;
let stubs: string;

beforeAll(() => {
  temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preflight-"));
  stubs = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preflight-stubs-"));
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

const stubbed = (stub: Partial<typeof VALID>) => {
  const result = NodeChildProcess.spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      PLISTBUDDY: NodePath.join(stubs, "PlistBuddy"),
      RUNNER_TEMP: temp,
      ...ALL_SET,
      ...VALID,
      ...stub,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe("desktop-preflight.sh", () => {
  it("names every missing value and stops before touching anything", () => {
    const result = preflight({});
    expect(result.status).toBe(1);
    for (const name of NAMES) expect(result.output).toContain(name);
    expect(NodeFS.readdirSync(temp)).toEqual([]);
  });

  it("names only the values that are missing", () => {
    const result = preflight({
      APPLE_TEAM_ID: "3TB6CJ6ZHV",
      CSC_LINK: SECRET,
      CSC_KEY_PASSWORD: SECRET,
      MACOS_PROVISIONING_PROFILE: SECRET,
      APPLE_API_KEY: SECRET,
      APPLE_API_KEY_ID: "",
      APPLE_API_ISSUER: "",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("APPLE_API_KEY_ID");
    expect(result.output).toContain("APPLE_API_ISSUER");
    expect(result.output).not.toMatch(/\bCSC_LINK\b/);
    expect(result.output).not.toContain(SECRET);
  });

  it("passes every check when the secrets are right, printing none of them", () => {
    const result = stubbed({});
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`ok: Developer ID Application identity for team ${TEAM}`);
    expect(result.output).toContain("ok: profile for");
    expect(result.output).toContain("ok: notarytool signed in");
    expect(result.output).not.toContain(SECRET);
  });

  it.each([
    [
      "a Developer ID for another team",
      { STUB_IDENTITY: "Developer ID Application: Someone Else (AAAAAAAAAA)" },
      `holds no valid Developer ID Application identity for team ${TEAM}`,
    ],
    [
      "a profile for another App ID",
      { STUB_APP_ID: `${TEAM}.com.example.other` },
      `The profile is for ${TEAM}.com.example.other`,
    ],
    [
      "a profile without Associated Domains",
      { STUB_DOMAINS: "" },
      "does not grant Associated Domains",
    ],
    [
      "an expired profile",
      { STUB_EXPIRES: "2020-01-01T00:00:00Z" },
      "The profile expired on 2020-01-01T00:00:00Z",
    ],
  ])("rejects %s", (_, stub, error) => {
    const result = stubbed(stub);
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::");
    expect(result.output).toContain(error);
    expect(result.output).not.toContain("ok: notarytool");
    expect(result.output).not.toContain(SECRET);
  });
});
