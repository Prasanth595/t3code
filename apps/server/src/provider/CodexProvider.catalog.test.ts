import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

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
const usage = JSON.parse(process.env.FAKE_CODEX_USAGE ?? "null");
const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "codex_cli_rs";
const ultrafast = process.env.FAKE_ULTRAFAST_ENTITLED === "1" && originator !== "codex_cli_rs";
const model = (tiers) => ({
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  serviceTiers: tiers.map((id) => ({ id, name: id, description: "" })),
});
const refreshCatalog = () => {
  const tiers = ultrafast ? ["priority", "ultrafast"] : ["priority"];
  fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: new Date().toISOString(), models: [model(tiers)] }));
};
if (usage) refreshCatalog();
else setTimeout(refreshCatalog, 300);
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  } else if (method === "account/read") {
    write({ id, result: usage
      ? { account: usage.account, requiresOpenaiAuth: usage.requiresOpenaiAuth }
      : { account: { type: "chatgpt", email: "test@example.com", planType: "promax" }, requiresOpenaiAuth: false } });
  } else if (method === "config/read") {
    write(usage?.config === null
      ? { id, error: { code: -32603, message: "config unreadable" } }
      : { id, result: { config: usage?.config ?? {}, origins: {} } });
  } else if (method === "account/rateLimits/read") {
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "rate-limits-requested"), "");
    write(usage?.rateLimitsFail
      ? { id, error: { code: -32600, message: "rate limits unavailable" } }
      : { id, result: { rateLimits: { primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: 1789436313 } } } });
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "model/list") {
    write({ id, result: { data: JSON.parse(fs.readFileSync(cachePath, "utf8")).models, nextCursor: null } });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const codexFixture = Effect.fn("codexFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
  const binaryPath = path.join(dir, "codex");
  yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  yield* fs.chmod(binaryPath, 0o755);
  return { fs, path, dir, settings: decodeCodexSettings({ binaryPath, homePath: dir }) };
});

const solServiceTiers = Effect.fn("solServiceTiers")(function* (ultrafastEntitled: boolean) {
  const { fs, path, dir, settings } = yield* codexFixture();

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
  const provider = yield* checkCodexProviderStatus(settings, undefined, {
    ...environment,
    FAKE_ULTRAFAST_ENTITLED: ultrafastEntitled ? "1" : "0",
  });
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

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex native usage", (it) => {
  const chatgpt = { type: "chatgpt", email: "test@example.com", planType: "pro" } as const;
  const customRoute = {
    model_provider: "hub",
    model_providers: { hub: { base_url: "https://hub.example.com/v1" } },
  };

  it.effect.each([
    ["custom without a login", null, false, customRoute, true, "unsupported"],
    ["stored ChatGPT login without OpenAI auth", chatgpt, false, {}, false, "unsupported"],
    ["custom requiring OpenAI auth", chatgpt, true, customRoute, false, "unsupported"],
    ["unreadable route", chatgpt, true, null, false, "unsupported"],
    ["API key requiring OpenAI auth", { type: "apiKey" }, true, {}, false, "unsupported"],
    ["confirmed native route", chatgpt, true, {}, false, undefined],
    ["native quota RPC failure", chatgpt, true, {}, true, "probeFailed"],
  ] as const)(
    "probes and publishes native quota only for eligible routing: %s",
    ([_name, account, requiresOpenaiAuth, config, rateLimitsFail, reason]) =>
      Effect.gen(function* () {
        const { fs, path, dir, settings } = yield* codexFixture();
        const provider = yield* checkCodexProviderStatus(settings, undefined, {
          ...process.env,
          FAKE_CODEX_USAGE: JSON.stringify({ account, requiresOpenaiAuth, config, rateLimitsFail }),
        });
        assert.strictEqual(provider.status, "ready", provider.message);
        assert.deepStrictEqual(
          {
            fetched: yield* fs.exists(path.join(dir, "rate-limits-requested")),
            usedPercents: provider.usageLimits?.windows.map((window) => window.usedPercent),
            reason: provider.usageLimits?.unavailable?.reason,
          },
          {
            fetched: reason !== "unsupported",
            usedPercents: reason === undefined ? [90] : [],
            reason,
          },
        );
      }).pipe(Effect.scoped),
  );
});
