// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { parse as parseYaml } from "yaml";

import { buildTriageContext, buildTriageLaunchPrompt, TRIAGE_PLAYBOOK } from "./triagePrompt.ts";

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Older releases fetch the repository playbook.
  const canonicalPath = NodePath.join(
    import.meta.dirname,
    "../../../../.github/triage/PLAYBOOK.md",
  );
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("routes reporters without triage permission to the labelled via-triage form", () => {
  // GitHub drops `--label` for accounts without triage permission; only the form applies it.
  const form: { readonly body: ReadonlyArray<{ readonly id?: string }> } = parseYaml(
    NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../../../../.github/ISSUE_TEMPLATE/via-triage.yml"),
      "utf8",
    ),
  );
  const fieldIds = form.body.flatMap((field) => (field.id === undefined ? [] : [field.id]));
  assert.isNotEmpty(fieldIds);
  assert.include(TRIAGE_PLAYBOOK, "--jq .permissions.triage");
  assert.include(
    TRIAGE_PLAYBOOK,
    "https://github.com/pingdotgg/t3code/issues/new?template=via-triage.yml",
  );
  for (const id of fieldIds) {
    assert.include(TRIAGE_PLAYBOOK, `\`${id}\``, `form field ${id} has no prefill parameter`);
  }
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // Windows .cmd shims cannot carry multiline argv.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file labels the CLI version as the CLI's, not the user's build", () => {
  const context = buildTriageContext({
    generatedAt: "2026-09-24T00:00:00.000Z",
    cliVersion: "0.0.42",
    os: "linux x64 (7.2.0)",
    nodeVersion: "v26.8.2",
    launchedAs: "npx t3 triage",
    server: "running (pid 42, http://127.0.0.1:3773, version 0.0.43-nightly.20260923.2173)",
    paths: {
      stateDir: "/home/u/.t3/userdata",
      dbPath: "/home/u/.t3/userdata/state.sqlite",
      settingsPath: "/home/u/.t3/userdata/settings.json",
      logsDir: "/home/u/.t3/userdata/logs",
      serviceLogPath: "/home/u/.t3/userdata/logs/boot-service.log",
      desktopBackendLogGlob: "/home/u/.t3/userdata/logs/server-child*.log*",
      serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.t3/caches",
      secretsDir: "/home/u/.t3/userdata/secrets",
      sourceCacheDir: "/home/u/.t3/source",
    },
  });
  assert.notInclude(context, "Installed version");
  assert.notInclude(context, "Release tag");
  assert.include(context, "- Triage CLI version: 0.0.42 (");
  assert.include(context, "version 0.0.43-nightly.20260923.2173");
});
