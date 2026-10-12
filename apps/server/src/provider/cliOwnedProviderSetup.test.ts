/**
 * Claude, OpenCode, and default Codex authenticate with their installed CLI. T3 Code
 * installs none of them and signs into none of them, so every snapshot declares
 * `canAuthenticate: false`.
 *
 * Clients read an *absent* `setup` as "unknown" and offer a sign-in that can only
 * fail with "This provider does not support sign-in in T3 Code." Declaring it
 * explicitly is what makes the UI offer nothing instead of offering a dead control.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "./CodexProvider.ts";
import { makePendingClaudeProvider } from "./ClaudeProvider.ts";

const CLI_SETUP = { canAuthenticate: false, canInstall: false };

const codexSettings = {
  enabled: true,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  setupMode: "existing" as const,
  customModels: [],
};

/**
 * A probe the status check can consume without spawning `codex`. The account
 * shape is only read for its `label`/`email`, neither of which these snapshots use.
 */
const readyProbe = () =>
  Effect.succeed({
    account: { type: "apiKey", requiresOpenaiAuth: true },
    version: "codex-cli 0.162.1",
    models: [],
    skills: [],
  }) as Effect.Effect<CodexAppServerProviderSnapshot>;

it.effect("declares no in-app sign-in for a CLI-owned Codex instance", () =>
  Effect.gen(function* () {
    const pending = yield* makePendingCodexProvider(codexSettings);
    assert.deepStrictEqual(pending.setup, CLI_SETUP);
  }),
);

it.effect("declares no in-app sign-in for a CLI-owned Claude instance", () =>
  Effect.gen(function* () {
    // Only `setup` is under test; the rest of `ClaudeSettings` is incidental.
    const pending = yield* makePendingClaudeProvider({
      enabled: true,
      binaryPath: "claude",
      homePath: "",
      customModels: [],
      launchArgs: "",
      autoCompactWindow: "",
    });
    assert.deepStrictEqual(pending.setup, CLI_SETUP);
  }),
);

it.effect("declares no in-app sign-in once the CLI login is verified", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkCodexProviderStatus(codexSettings, readyProbe, {}).pipe(
      Effect.provide(NodeServices.layer),
    );
    assert.deepStrictEqual(snapshot.setup, CLI_SETUP);
  }),
);

it.effect("keeps declaring it when the probe fails, so the UI never offers a dead sign-in", () =>
  Effect.gen(function* () {
    // A failed probe is the state a user lands in when their CLI login expired.
    // It must not be the state that makes T3 Code offer to sign them in again.
    const failed = yield* Effect.exit(
      checkCodexProviderStatus(codexSettings, () => Effect.succeed({}) as never, {}).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    if (Exit.isSuccess(failed)) {
      assert.deepStrictEqual(failed.value.setup, CLI_SETUP);
    }
  }),
);
