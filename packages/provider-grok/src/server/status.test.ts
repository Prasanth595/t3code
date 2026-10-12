/**
 * Grok Build authenticates with the installed CLI (`grok login`), so every snapshot
 * must declare `canAuthenticate: false`.
 *
 * Clients test `canAuthenticate === true`, never `!== false`, so a snapshot that
 * omits `setup` renders a Sign in button whose only outcome is the raw error
 * `This provider does not support sign-in in T3 Code.` The provider still works,
 * which makes the failure read as a broken provider rather than a missing field.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { GrokSettings } from "../settings.ts";
import { checkGrokProviderStatus } from "./status.ts";

const settings = (overrides: Partial<GrokSettings> = {}): GrokSettings =>
  ({
    enabled: false,
    binaryPath: "grok",
    serverUrl: "",
    serverPassword: "",
    launchArgs: "",
    customModels: [],
    ...overrides,
  }) as GrokSettings;

it.effect("declares no in-app sign-in, whatever the probe reports", () =>
  Effect.gen(function* () {
    // The disabled branch returns before spawning, so no ChildProcessSpawner is
    // needed. An enabled instance would spawn `grok`; the declaration is applied
    // by the same wrapper on every branch.
    const snapshot = yield* checkGrokProviderStatus(settings({}), {});
    assert.deepStrictEqual(snapshot.setup, { canAuthenticate: false, canInstall: false });
  }),
);
