import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus, probeCodexSkillsForCwd } from "./CodexProvider.ts";

/**
 * Stand-in for Codex 0.162's app-server catalog behavior:
 * - `model/list` answers from `CODEX_HOME/models_cache.json` while it is fresh.
 * - A startup refresh runs before `initialize`, so it uses the originator set
 *   at spawn (the override env var, else the plain CLI's `codex_cli_rs`).
 * - The backend grants Ultrafast only to entitled accounts on app originators.
 */
const FAKE_CODEX_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const cachePath = path.join(process.env.CODEX_HOME, "models_cache.json");
const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "codex_cli_rs";
const ultrafast = process.env.FAKE_ULTRAFAST_ENTITLED === "1" && originator !== "codex_cli_rs";
const model = (tiers) => ({
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  serviceTiers: tiers.map((id) => ({ id, name: id, description: "" })),
});
setTimeout(() => {
  const tiers = ultrafast ? ["priority", "ultrafast"] : ["priority"];
  fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: new Date().toISOString(), models: [model(tiers)] }));
}, 300);
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (process.env.FAKE_CWD_RECEIPT) {
    fs.appendFileSync(process.env.FAKE_CWD_RECEIPT, JSON.stringify({ method, cwd: process.cwd(), cwds: params?.cwds, home: process.env.HOME, codexHome: process.env.CODEX_HOME }) + "\n");
  }
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  } else if (method === "account/read") {
    write({ id, result: { account: process.env.FAKE_CWD_RECEIPT ? { type: "apiKey" } : { type: "chatgpt", email: "test@example.com", planType: "promax" }, requiresOpenaiAuth: false } });
  } else if (method === "skills/list") {
    const skill = (name) => ({ name, path: path.join(process.cwd(), name, "SKILL.md"), description: "", enabled: true, scope: "repo" });
    const cwd = process.env.FAKE_EXPECTED_CWD;
    write({ id, result: { data: cwd ? [
      { cwd: "/unrelated-workspace", skills: [skill("decoy")], errors: [] },
      { cwd, skills: [skill("selected")], errors: [] },
    ] : [] } });
  } else if (method === "model/list") {
    write({ id, result: { data: process.env.FAKE_CWD_RECEIPT ? [model([])] : JSON.parse(fs.readFileSync(cachePath, "utf8")).models, nextCursor: null } });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const solServiceTiers = Effect.fn("solServiceTiers")(function* (ultrafastEntitled: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
  const binaryPath = path.join(dir, "codex");
  yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  yield* fs.chmod(binaryPath, 0o755);

  yield* fs.writeFileString(
    path.join(dir, "models_cache.json"),
    JSON.stringify({
      fetched_at: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      models: [
        {
          id: "gpt-6.1-sol",
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          description: "",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
          serviceTiers: (ultrafastEntitled ? ["priority"] : ["priority", "ultrafast"]).map(
            (id) => ({ id, name: id, description: "" }),
          ),
        },
      ],
    }),
  );

  const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
  const provider = yield* checkCodexProviderStatus(
    decodeCodexSettings({ binaryPath, homePath: dir }),
    undefined,
    { ...environment, FAKE_ULTRAFAST_ENTITLED: ultrafastEntitled ? "1" : "0" },
  );
  const serviceTier = provider.models
    .find((model) => model.slug === "gpt-6.1-sol")
    ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");
  return serviceTier?.type === "select" ? serviceTier.options.map((option) => option.id) : [];
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex catalog discovery", (it) => {
  it.effect("keeps Ultrafast when another Codex client wrote the shared catalog cache", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(true), ["default", "priority", "ultrafast"]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops Ultrafast once the account is no longer entitled to it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(false), ["default", "priority"]);
    }).pipe(Effect.scoped),
  );
});

const cwdReceipt = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      method: Schema.String,
      cwd: Schema.String,
      cwds: Schema.optionalKey(Schema.Array(Schema.String)),
      home: Schema.String,
      codexHome: Schema.String,
    }),
  ),
);
const decodeCwdReceipt = Schema.decodeUnknownSync(cwdReceipt);

const makeCwdFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cwd-" });
  const home = path.join(root, "synthetic-home");
  const metadata = path.join(home, "metadata");
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "isolated-codex-home");
  const receipt = path.join(root, "cwd.jsonl");
  const binaryPath = path.join(root, "fake-codex");
  for (const directory of [metadata, workspace, codexHome, path.join(home, ".codex")]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  yield* fs.writeFileString(
    path.join(home, ".codex", "config.toml"),
    'model = "synthetic-native-sentinel"\n',
  );
  yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  yield* fs.chmod(binaryPath, 0o755);
  const physicalMetadata = yield* fs.realPath(metadata);
  const environment = {
    HOME: home,
    FAKE_CWD_RECEIPT: receipt,
    FAKE_EXPECTED_CWD: physicalMetadata,
  };
  const readReceipt = fs
    .readFileString(receipt)
    .pipe(Effect.map((text) => decodeCwdReceipt(`[${text.trim().split("\n").join(",")}]`)));
  return {
    fs,
    path,
    home,
    metadata,
    workspace,
    codexHome,
    receipt,
    binaryPath,
    physicalMetadata,
    environment,
    readReceipt,
  };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex metadata cwd", (it) => {
  it.effect("uses one physical host-expanded directory for status spawn and skills selection", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCwdFixture();
      yield* fixture.fs.symlink(
        fixture.metadata,
        fixture.path.join(fixture.home, "metadata-alias"),
      );
      for (const [metadataCwd, expectedCwd] of [
        ["~/metadata-alias", fixture.physicalMetadata],
        ["~", yield* fixture.fs.realPath(fixture.home)],
      ] satisfies ReadonlyArray<readonly [string, string]>) {
        yield* fixture.fs.writeFileString(fixture.receipt, "");
        const provider = yield* checkCodexProviderStatus(
          decodeCodexSettings({
            binaryPath: fixture.binaryPath,
            homePath: fixture.codexHome,
            metadataCwd,
          }),
          undefined,
          { ...fixture.environment, FAKE_EXPECTED_CWD: expectedCwd },
        ).pipe(Effect.provideService(HostProcess.HomeDirectory, fixture.home));
        assert.equal(provider.status, "ready", provider.message);
        assert.deepStrictEqual(
          provider.skills.map((skill) => skill.name),
          ["selected"],
        );
        const receipt = yield* fixture.readReceipt;
        assert.isTrue(receipt.length > 0);
        for (const call of receipt) {
          assert.equal(call.cwd, expectedCwd);
          assert.equal(call.home, fixture.home);
          assert.equal(call.codexHome, fixture.codexHome);
        }
        assert.deepStrictEqual(receipt.find((call) => call.method === "skills/list")?.cwds, [
          expectedCwd,
        ]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the explicit workspace for workspace skills", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCwdFixture();
      const cwd = yield* fixture.fs.realPath(fixture.workspace);
      const skills = yield* probeCodexSkillsForCwd({
        binaryPath: fixture.binaryPath,
        homePath: fixture.codexHome,
        cwd,
        environment: { ...fixture.environment, FAKE_EXPECTED_CWD: cwd },
      });
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["selected"],
      );
      const receipt = yield* fixture.readReceipt;
      assert.deepStrictEqual(receipt.find((call) => call.method === "skills/list")?.cwds, [cwd]);
      assert.isTrue(receipt.every((call) => call.cwd === cwd));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps process cwd without new filesystem work when the option is absent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCwdFixture();
      const provider = yield* checkCodexProviderStatus(
        decodeCodexSettings({ binaryPath: fixture.binaryPath, homePath: fixture.codexHome }),
        undefined,
        { ...fixture.environment, FAKE_EXPECTED_CWD: process.cwd() },
      ).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            realPath: () => Effect.die("Absent metadata must not resolve a path"),
            stat: () => Effect.die("Absent metadata must not stat a path"),
          }),
        ),
      );
      assert.equal(provider.status, "ready", provider.message);
      assert.deepStrictEqual(
        provider.skills.map((skill) => skill.name),
        ["selected"],
      );
      assert.isTrue((yield* fixture.readReceipt).every((call) => call.cwd === process.cwd()));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reports relative, missing and non-directory metadata without spawning or falling back",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeCwdFixture();
        const spawned: Array<string> = [];
        for (const metadataCwd of [
          "relative/metadata",
          fixture.path.join(fixture.home, "missing"),
          fixture.binaryPath,
        ]) {
          const provider = yield* checkCodexProviderStatus(
            decodeCodexSettings({ binaryPath: fixture.binaryPath, metadataCwd }),
            undefined,
            fixture.environment,
          ).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => {
                spawned.push(metadataCwd);
                return Effect.die("Invalid metadata must not spawn");
              }),
            ),
          );
          assert.equal(provider.status, "error");
          assert.isTrue(provider.installed);
          assert.include(provider.message ?? "", "directory");
          assert.notInclude(provider.message ?? "", "Could not start Codex CLI");
        }
        assert.deepStrictEqual(spawned, []);
      }).pipe(Effect.scoped),
  );
});
