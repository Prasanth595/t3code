import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageLimitsReport from "./UsageLimitsReport.ts";

const checkedAt = "2026-10-21T10:00:00.000Z";

const limits = (overrides: Partial<ServerProviderUsageLimits> = {}): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "5h",
      usedPercent: 27.6,
      resetsAt: "2026-10-21T12:00:00.000Z",
      windowDurationMins: 300,
    },
    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 60 },
  ],
  ...overrides,
});

const provider = (id: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const layerSources = (sources: ReadonlyArray<UsageLimitSourceSnapshot> = []) =>
  Layer.mock(UsageLimitSources.UsageLimitSources)({
    current: Effect.succeed(sources),
    refresh: Effect.void,
  });

const read = (refresh = false) =>
  Effect.flatMap(UsageLimitsReport.UsageLimitsReport, (report) => report.read({ refresh }));

it.effect("reports each enabled provider's remaining headroom and reset time", () =>
  Effect.gen(function* () {
    const report = yield* read().pipe(
      Effect.provide(
        UsageLimitsReport.layer.pipe(
          Layer.provide(
            ProviderRegistryMock.layer([
              provider("claudeAgent", {
                displayName: "Claude",
                auth: { status: "authenticated", label: "Max", email: "dev@example.com" },
                usageLimits: limits(),
              }),
              provider("cursor", { enabled: false, usageLimits: limits() }),
            ]),
          ),
          Layer.provide(layerSources()),
        ),
      ),
    );

    assert.deepStrictEqual(report.providers, [
      {
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        driverKind: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude",
        email: "dev@example.com",
        plan: "Max",
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5h",
            usedPercent: 27.6,
            remainingPercent: 72,
            resetsAt: "2026-10-21T12:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 60,
            remainingPercent: 40,
            resetsAt: null,
            windowDurationMins: null,
          },
        ],
        unavailable: null,
      },
    ]);
  }),
);

it.effect("says why a provider's windows do not show its headroom", () =>
  Effect.gen(function* () {
    const report = yield* read().pipe(
      Effect.provide(
        UsageLimitsReport.layer.pipe(
          Layer.provide(
            ProviderRegistryMock.layer([
              provider("apiKey", {
                usageLimits: limits({
                  windows: [],
                  unavailable: { reason: "unsupported", message: "API keys have no limits." },
                }),
              }),
              provider("failed", {
                usageLimits: limits({ unavailable: { reason: "probeFailed" } }),
              }),
              provider("silent"),
              provider("failedUpdate", {
                status: "error",
                message: "Provider refresh failed after update.",
                usageLimits: limits(),
              }),
              provider("signedOut", {
                auth: { status: "unauthenticated" },
                usageLimits: limits(),
              }),
            ]),
          ),
          Layer.provide(layerSources()),
        ),
      ),
    );

    assert.deepStrictEqual(
      report.providers.map(
        (entry) => [String(entry.providerInstanceId), entry.unavailable] as const,
      ),
      [
        ["apiKey", { reason: "unsupported", message: "API keys have no limits." }],
        ["failed", { reason: "probeFailed", message: "Could not read limits." }],
        [
          "silent",
          { reason: "notReported", message: "This provider has not reported usage limits." },
        ],
        [
          "failedUpdate",
          { reason: "providerUnavailable", message: "Provider refresh failed after update." },
        ],
        [
          "signedOut",
          { reason: "providerUnavailable", message: "This provider is not signed in." },
        ],
      ],
    );
    assert.deepStrictEqual(
      report.providers.find((entry) => entry.providerInstanceId === "signedOut")?.windows,
      [],
    );
  }),
);

it.effect("includes hub accounts and the errors of hubs that could not be read", () =>
  Effect.gen(function* () {
    const report = yield* read().pipe(
      Effect.provide(
        UsageLimitsReport.layer.pipe(
          Layer.provide(ProviderRegistryMock.layer([])),
          Layer.provide(
            layerSources([
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy",
                label: "Team hub",
                checkedAt,
                accounts: [
                  {
                    id: "codex-1.json",
                    driver: ProviderDriverKind.make("codex"),
                    plan: "Pro",
                    usageLimits: limits(),
                  },
                ],
              },
              {
                id: UsageLimitSourceId.make("down"),
                kind: "cliproxy",
                label: "Down hub",
                checkedAt,
                accounts: [],
                error: "Connection refused.",
              },
            ]),
          ),
        ),
      ),
    );

    assert.deepStrictEqual(
      report.pooledAccounts.map((account) => ({
        sourceLabel: account.sourceLabel,
        accountId: account.accountId,
        plan: account.plan,
        remaining: account.windows.map((window) => window.remainingPercent),
      })),
      [{ sourceLabel: "Team hub", accountId: "codex-1.json", plan: "Pro", remaining: [72, 40] }],
    );
    assert.deepStrictEqual(report.notices, ["Down hub: Connection refused."]);
  }),
);

it.effect("re-reads providers before answering when asked to refresh", () =>
  Effect.gen(function* () {
    const stale = provider("codex", { usageLimits: limits({ checkedAt: "2026-10-20T00:00:00Z" }) });
    const fresh = provider("codex", { usageLimits: limits() });
    const current = yield* Ref.make<ReadonlyArray<ServerProvider>>([stale]);
    const layerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Ref.get(current),
      refresh: () => Ref.setAndGet(current, [fresh]),
    });
    const readWith = (refresh: boolean) =>
      read(refresh).pipe(
        Effect.provide(
          UsageLimitsReport.layer.pipe(Layer.provide(layerRegistry), Layer.provide(layerSources())),
        ),
      );

    assert.strictEqual((yield* readWith(false)).providers[0]?.checkedAt, "2026-10-20T00:00:00Z");
    assert.strictEqual((yield* readWith(true)).providers[0]?.checkedAt, checkedAt);
  }),
);
