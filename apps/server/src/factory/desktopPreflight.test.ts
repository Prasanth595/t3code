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

const SECRET = "c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1wcmludA";

let temp: string;

beforeAll(() => {
  temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preflight-"));
});

afterAll(() => {
  NodeFS.rmSync(temp, { recursive: true, force: true });
});

// Only PATH and RUNNER_TEMP from outside, so a developer's own signing variables never leak in.
const preflight = (values: Partial<Record<(typeof NAMES)[number], string>>) => {
  const result = NodeChildProcess.spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: temp, ...values },
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
});
