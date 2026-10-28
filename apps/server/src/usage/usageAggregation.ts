// @effect-diagnostics globalDate:off
import type {
  UsageBucket,
  UsageCategoryCost,
  UsageDay,
  UsageProviderKind,
  UsageResolution,
  UsageSessionSpend,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";

// en-CA gives ISO-ordered parts in the requested zone; Date getters are host-local.
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // Cache quarter-hour slots to avoid per-record Intl calls; fixed-offset midnight can split slots and needs exact formatting.
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(new Date(slot * QUARTER_HOUR_MS));
      const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface PricedAccumulator {
  totals: { -readonly [K in keyof UsageTokenTotals]: number };
  costUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
}

interface MutableBucket extends PricedAccumulator {
  cacheSavingsUsd: number;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  sessions: Set<string>;
}

interface MutableSession extends PricedAccumulator {
  provider: UsageProviderKind;
  sessionId: string;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
  /** Dashboard scans leave this off so they do not retain a session map. */
  readonly collectSessions?: boolean;
}

export function resolveModelAliases(
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  for (const model of Object.keys(aliases)) {
    const seen = new Set([model]);
    let target = aliases[model]!;
    while (Object.hasOwn(aliases, target) && !seen.has(target)) {
      seen.add(target);
      target = aliases[target]!;
    }
    if (!Object.hasOwn(aliases, target)) resolved.set(model, target);
  }
  return resolved;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
}

/** Deduplicates across the whole scan; Claude copies records into resumed/forked transcripts. */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #sessions: Map<string, MutableSession> | null;
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
  #lastBucket: {
    readonly day: string;
    readonly hourIndex: number;
    readonly provider: string;
    readonly model: string;
    readonly source: string;
    readonly bucket: MutableBucket;
  } | null = null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#sessions = options.collectSessions === true ? new Map() : null;
    this.#toDay = makeDayFormatter(options.timeZone);
    if (options.resolution === "hour") {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) {
        throw new Error("Hourly usage aggregation requires exact time bounds");
      }
      this.#hourlyWindow = {
        sinceTimeMs: options.sinceTimeMs,
        untilTimeMs: options.untilTimeMs,
      };
    } else {
      this.#hourlyWindow = null;
    }
  }

  add(input: UsageRecord, sourcePath?: string): boolean {
    const record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

    if (
      this.#hourlyWindow !== null &&
      (record.timestampMs < this.#hourlyWindow.sinceTimeMs ||
        record.timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const hourIndex =
      this.#hourlyWindow === null
        ? -1
        : Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS);
    const bucket = this.#bucketFor(day, hourIndex, record.provider, record.model, sourcePath ?? "");

    const priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides);
    accumulatePriced(bucket, record.totals, priced.costUsd, priced.categoryCostUsd);
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (record.speed === "fast") bucket.fastCostUsd += priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd += priced.costUsd;
    bucket.speedPremiumUsd += priced.speedPremiumUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.#options.rates,
      record,
      this.#options.priceOverrides,
    );
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    if (this.#sessions !== null && record.sessionId.length > 0) {
      const key = `${record.provider}\u0000${record.sessionId}`;
      let session = this.#sessions.get(key);
      if (session === undefined) {
        session = {
          provider: record.provider,
          sessionId: record.sessionId,
          totals: { ...EMPTY_TOTALS },
          costUsd: 0,
          categoryCostUsd: null,
          records: 0,
          unpricedRecords: 0,
          providerReportedRecords: 0,
        };
        this.#sessions.set(key, session);
      }
      accumulatePriced(session, record.totals, priced.costUsd, priced.categoryCostUsd);
      if (priced.costSource === "unpriced") session.unpricedRecords += 1;
      if (priced.costSource === "providerReported") session.providerReportedRecords += 1;
    }
    return true;
  }

  // Aliases use the target's rate, replacing provider-specific rateModel.
  #mapModel(record: UsageRecord): UsageRecord {
    const model = this.#options.modelAliases?.get(record.model);
    if (model === undefined) return record;
    const { rateModel: _rateModel, ...rest } = record;
    return { ...rest, model };
  }

  // Time-ordered records usually reuse the previous bucket; avoid rebuilding its key.
  #bucketFor(
    day: string,
    hourIndex: number,
    provider: string,
    model: string,
    source: string,
  ): MutableBucket {
    const last = this.#lastBucket;
    if (
      last !== null &&
      last.day === day &&
      last.hourIndex === hourIndex &&
      last.provider === provider &&
      last.model === model &&
      last.source === source
    ) {
      return last.bucket;
    }
    const window = this.#hourlyWindow;
    const hourStart =
      window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
    const key = `${day}\u0000${hourStart}\u0000${provider}\u0000${model}\u0000${source}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: { ...EMPTY_TOTALS },
        costUsd: 0,
        cacheSavingsUsd: 0,
        categoryCostUsd: null,
        fastCostUsd: 0,
        ultrafastCostUsd: 0,
        speedPremiumUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }
    this.#lastBucket = { day, hourIndex, provider, model, source, bucket };
    return bucket;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = "", sourcePath = ""] =
        key.split("\u0000");
      const category = bucket.categoryCostUsd;
      const fastCostUsd = roundUsd(bucket.fastCostUsd);
      const ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd);
      const speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        ...(sourcePath === "" ? {} : { sourcePath }),
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        ...(fastCostUsd === 0 ? {} : { fastCostUsd }),
        ...(ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd }),
        ...(speedPremiumUsd === 0 ? {} : { speedPremiumUsd }),
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }

  /** Empty unless `collectSessions` was set. Omits records that never named a session. */
  finishSessions(): readonly UsageSessionSpend[] {
    if (this.#sessions === null) return [];
    const sessions: UsageSessionSpend[] = [];
    for (const session of this.#sessions.values()) {
      const category = session.categoryCostUsd;
      sessions.push({
        provider: session.provider,
        sessionId: session.sessionId,
        totals: { ...session.totals },
        costUsd: session.costUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        costSource: resolveCostSource(session),
        records: session.records,
        unpricedRecords: session.unpricedRecords,
      });
    }
    sessions.sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.sessionId.localeCompare(b.sessionId),
    );
    return sessions;
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function accumulatePriced(
  target: PricedAccumulator,
  totals: UsageTokenTotals,
  costUsd: number,
  categoryCostUsd: UsageCategoryCost | null,
): void {
  target.totals.uncachedInputTokens += totals.uncachedInputTokens;
  target.totals.cachedInputTokens += totals.cachedInputTokens;
  target.totals.cacheCreationTokens += totals.cacheCreationTokens;
  target.totals.outputTokens += totals.outputTokens;
  target.totals.reasoningTokens += totals.reasoningTokens;
  target.costUsd += costUsd;
  target.records += 1;
  if (categoryCostUsd === null) return;
  const current = target.categoryCostUsd;
  target.categoryCostUsd =
    current === null
      ? categoryCostUsd
      : {
          input: current.input + categoryCostUsd.input,
          cacheRead: current.cacheRead + categoryCostUsd.cacheRead,
          cacheWrite: current.cacheWrite + categoryCostUsd.cacheWrite,
          output: current.output + categoryCostUsd.output,
        };
}

function resolveCostSource(bucket: PricedAccumulator): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
