import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageBucket,
  type UsageLimitSourceSnapshot,
  type UsageSource,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageReport from "./UsageReport.ts";
import * as UsageService from "./UsageService.ts";

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

const bucket = (overrides: Partial<UsageBucket>): UsageBucket => ({
  day: UsageDay.make("2026-10-20"),
  provider: "codex",
  model: "gpt-5.5",
  totals: {
    uncachedInputTokens: 1_000,
    cachedInputTokens: 9_000,
    cacheCreationTokens: 0,
    outputTokens: 500,
    reasoningTokens: 200,
  },
  costUsd: 1.005,
  cacheSavingsUsd: 0.5,
  costSource: "modelPriced",
  records: 4,
  unpricedRecords: 0,
  sessions: 1,
  ...overrides,
});

const source = (
  usageProvider: UsageSource["fingerprint"]["provider"],
  overrides: Partial<UsageSource> = {},
): UsageSource => ({
  fingerprint: {
    hostId: "host",
    provider: usageProvider,
    resolvedHomePath: `/home/dev/.${usageProvider}`,
    volumeId: "1:1",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 2,
  message: null,
  ...overrides,
});

const layerUsage = (
  buckets: ReadonlyArray<UsageBucket>,
  requests: Array<UsageSummaryInput> = [],
  sources: ReadonlyArray<UsageSource> = [source("codex"), source("claude")],
): Layer.Layer<UsageService.UsageService> =>
  Layer.mock(UsageService.UsageService)({
    readSummary: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: checkedAt,
          timeZone: input.timeZone,
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          buckets,
          sources,
          pricing: { status: "fresh", source: "test", fetchedAt: checkedAt, knownModels: 1 },
          scanDurationMs: 0,
        };
      }),
  });

interface Dependencies {
  readonly registry?: Layer.Layer<ProviderRegistry.ProviderRegistry>;
  readonly sources?: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly usage?: Layer.Layer<UsageService.UsageService>;
}

const layerReport = (dependencies: Dependencies) =>
  UsageReport.layer.pipe(
    Layer.provide(dependencies.registry ?? ProviderRegistryMock.layer([])),
    Layer.provide(
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed(dependencies.sources ?? []),
        refresh: Effect.void,
      }),
    ),
    Layer.provide(dependencies.usage ?? layerUsage([])),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("usage-report-test"),
          label: "Test environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      }),
    ),
  );

const readLimits = (dependencies: Dependencies, refresh = false) =>
  Effect.flatMap(UsageReport.UsageReport, (report) => report.readLimits({ refresh })).pipe(
    Effect.provide(layerReport(dependencies)),
  );

const readSpend = (dependencies: Dependencies, days: 1 | 7 | 30 | 90 = 30) =>
  Effect.flatMap(UsageReport.UsageReport, (report) =>
    report.readSpend({ days, refresh: false }),
  ).pipe(Effect.provide(layerReport(dependencies)));

it.effect("reports each enabled provider's remaining headroom and reset time", () =>
  Effect.gen(function* () {
    const report = yield* readLimits({
      registry: ProviderRegistryMock.layer([
        provider("claudeAgent", {
          displayName: "Claude",
          auth: { status: "authenticated", label: "Max", email: "dev@example.com" },
          usageLimits: limits(),
        }),
        provider("cursor", { enabled: false, usageLimits: limits() }),
      ]),
    });

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
    const report = yield* readLimits({
      registry: ProviderRegistryMock.layer([
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
    });

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
    const report = yield* readLimits({
      sources: [
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
      ],
    });

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
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Ref.get(current),
      refresh: () => Ref.setAndGet(current, [fresh]),
    });

    assert.strictEqual(
      (yield* readLimits({ registry })).providers[0]?.checkedAt,
      "2026-10-20T00:00:00Z",
    );
    assert.strictEqual((yield* readLimits({ registry }, true)).providers[0]?.checkedAt, checkedAt);
  }),
);

it.effect("totals spend by provider, model, and day for the Usage tab's window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T12:00:00Z"));
    const requests: Array<UsageSummaryInput> = [];
    const spend = yield* readSpend(
      {
        usage: layerUsage(
          [
            bucket({}),
            bucket({ day: UsageDay.make("2026-10-21"), costUsd: 2 }),
            bucket({
              provider: "claude",
              model: "claude-opus-5-5",
              costUsd: 0,
              costSource: "unpriced",
              unpricedRecords: 4,
            }),
          ],
          requests,
        ),
      },
      7,
    );

    assert.strictEqual(requests[0]?.resolution, "day");
    assert.deepStrictEqual(
      [requests[0]?.sinceDay, requests[0]?.untilDay],
      ["2026-10-15", "2026-10-21"],
    );
    assert.strictEqual(spend.window.days, 7);
    assert.strictEqual(spend.costUsd, 3.01);
    assert.strictEqual(spend.tokens.total, 31_500);
    assert.strictEqual(spend.sessions, 4);
    assert.deepStrictEqual(
      spend.providers.map((entry) => [entry.provider, entry.costUsd, entry.totalTokens]),
      [
        ["codex", 3.01, 21_000],
        ["claude", 0, 10_500],
      ],
    );
    assert.deepStrictEqual(
      spend.models.map((model) => [model.model, model.costUsd]),
      [
        ["gpt-5.5", 3.01],
        ["claude-opus-5-5", null],
      ],
    );
    assert.deepStrictEqual(
      spend.periods.map((period) => [period.start, period.costUsd]),
      [
        ["2026-10-20", 1.01],
        ["2026-10-21", 2],
      ],
    );
  }),
);

it.effect("reads the past 24 hours by hour, as the Usage tab does", () =>
  Effect.gen(function* () {
    const requests: Array<UsageSummaryInput> = [];
    const spend = yield* readSpend(
      { usage: layerUsage([bucket({ hourStart: "2026-10-20T14:00:00.000Z" })], requests) },
      1,
    );

    assert.strictEqual(requests[0]?.resolution, "hour");
    assert.deepStrictEqual(
      spend.periods.map((period) => period.start),
      ["2026-10-20T14:00:00.000Z"],
    );
  }),
);

it.effect("says when spend leaves out a source that is still loading or cannot be read", () =>
  Effect.gen(function* () {
    const spend = yield* readSpend({
      usage: layerUsage(
        [bucket({})],
        [],
        [
          source("codex", { refreshing: true }),
          source("cursor", { status: "missing", message: "Cursor account usage is off." }),
          source("claude", { status: "missing", message: "No Claude transcripts found." }),
        ],
      ),
    });

    assert.deepStrictEqual(spend.notices, [
      "codex usage is still being read, so spend leaves it out. Pass refresh: true to wait for it.",
      "Cursor account usage is off.",
    ]);
  }),
);
