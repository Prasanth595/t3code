const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { parseEnv } = require("node:util");

const workflow = readFileSync(join(__dirname, "../workflows/mobile-eas-production.yml"), "utf8");
const step = workflow.match(
  /- name: Pull production environment variables\n[\s\S]*?        run: (?:\|\n((?:          .*\n|\n)+)|([^\n]+))/,
);
assert.ok(step, "Could not find the production environment workflow step");
const script = step[1]?.replace(/^          /gm, "") ?? step[2];

function runStep(envFile, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "t3-mobile-production-env-"));
  try {
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");
    writeFileSync(join(dir, "fixture.env"), envFile);
    const result = spawnSync(
      "bash",
      ["-e", "-c", 'eas() { cp fixture.env .env.local; return "$FIXTURE_EXIT"; }\n' + script],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_ENV: githubEnv,
          FIXTURE_EXIT: String(exitCode),
        },
      },
    );
    assert.ifError(result.error);
    return { ...result, exported: { ...parseEnv(readFileSync(githubEnv, "utf8")) } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("preserves the downloaded Android file for fingerprint and OTA commands that disable dotenv", () => {
  const file = "/runner/mobile/.eas/.env/google services.json";
  const result = runStep(
    `T3CODE_ANDROID_GOOGLE_SERVICES_FILE="${file}"\nEXPO_PUBLIC_OTHER=fixture\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.exported, { T3CODE_ANDROID_GOOGLE_SERVICES_FILE: file });
});

test("keeps the Android file optional and stops when pulling the environment fails", () => {
  for (const content of ["EXPO_PUBLIC_OTHER=fixture\n", "T3CODE_ANDROID_GOOGLE_SERVICES_FILE=\n"]) {
    const result = runStep(content);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.exported, {});
  }
  const failed = runStep("T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/fixture.json\n", 1);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(failed.exported, {});
});
