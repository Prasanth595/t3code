import type {
  SaasAdminSettingsRequest,
  SaasAdminSettingsResponse,
  SaasAdminUser,
  SaasPlan,
  SaasUsage,
} from "@t3tools/contracts/saas";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  saasAccounts,
  saasLlmKeys,
  saasPlans,
  saasSettings,
  saasUsage,
} from "../persistence/schema.ts";
import * as SaasCrypto from "./SaasCrypto.ts";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const DEEPSEEK_KEY_SETTING = "deepseek_api_key";
const DEEPSEEK_MODEL_SETTING = "deepseek_model";
const ANONYMOUS_CHAT_LIMIT_SETTING = "anonymous_daily_chat_limit";
export const DEFAULT_ANONYMOUS_DAILY_CHAT_LIMIT = 10;

export class SaasPersistenceError extends Schema.TaggedError<SaasPersistenceError>()(
  "SaasPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `SaaS persistence operation '${this.operation}' failed.`;
  }
}

export class SaasPlanNotFound extends Schema.TaggedError<SaasPlanNotFound>()("SaasPlanNotFound", {
  planId: Schema.String,
}) {}

export class SaasUserNotFound extends Schema.TaggedError<SaasUserNotFound>()("SaasUserNotFound", {
  userId: Schema.String,
}) {}

/** Usage resets on the first of each calendar month, in UTC. */
export const usagePeriod = (now: DateTime.Utc): string =>
  DateTime.formatIso(now).slice(0, "YYYY-MM".length);

export const emptyUsage = (period: string): SaasUsage => ({
  period,
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
});

export const usedTokens = (usage: SaasUsage) => usage.inputTokens + usage.outputTokens;

export const hasQuotaLeft = (plan: SaasPlan, usage: SaasUsage) =>
  usedTokens(usage) < plan.monthlyTokenLimit;

/** Stripe keeps `past_due` subscriptions billable while it retries the card. */
export const isLiveSubscriptionStatus = (status: string) =>
  status === "active" || status === "trialing" || status === "past_due";

export interface SaasAccountView {
  readonly userId: string;
  readonly email: string | null;
  readonly plan: SaasPlan;
  readonly usage: SaasUsage;
  readonly hasLlmKey: boolean;
}

export class SaasAccounts extends Context.Service<
  SaasAccounts,
  {
    readonly getAccount: (input: {
      readonly userId: string;
      readonly email: string | null;
    }) => Effect.Effect<SaasAccountView, SaasPersistenceError>;
    /** Issues a key for one computer; the account's other computers keep theirs. */
    readonly createLlmKey: (userId: string) => Effect.Effect<string, SaasPersistenceError>;
    readonly resolveLlmKey: (
      apiKey: string,
    ) => Effect.Effect<Option.Option<SaasAccountView>, SaasPersistenceError>;
    readonly recordUsage: (input: {
      readonly userId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }) => Effect.Effect<void, SaasPersistenceError>;
    readonly listUsers: Effect.Effect<ReadonlyArray<SaasAdminUser>, SaasPersistenceError>;
    readonly setUserPlan: (input: {
      readonly userId: string;
      readonly planId: string;
    }) => Effect.Effect<void, SaasPersistenceError | SaasPlanNotFound | SaasUserNotFound>;
    readonly listPlans: Effect.Effect<ReadonlyArray<SaasPlan>, SaasPersistenceError>;
    readonly savePlan: (plan: SaasPlan) => Effect.Effect<SaasPlan, SaasPersistenceError>;
    readonly getSettings: Effect.Effect<SaasAdminSettingsResponse, SaasPersistenceError>;
    readonly saveSettings: (
      input: SaasAdminSettingsRequest,
    ) => Effect.Effect<SaasAdminSettingsResponse, SaasPersistenceError>;
    readonly getStripeCustomerId: (
      userId: string,
    ) => Effect.Effect<string | null, SaasPersistenceError>;
    readonly setStripeCustomerId: (input: {
      readonly userId: string;
      readonly customerId: string;
    }) => Effect.Effect<void, SaasPersistenceError>;
    /**
     * Applies a Stripe subscription state to the account that owns the customer. A live
     * subscription moves the account to the plan with the price; anything else returns it
     * to the default plan.
     */
    readonly applySubscription: (input: {
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly status: string;
      readonly priceId: string | null;
    }) => Effect.Effect<void, SaasPersistenceError>;
    readonly getModelAccess: Effect.Effect<
      { readonly apiKey: Redacted.Redacted<string> | null; readonly model: string },
      SaasPersistenceError
    >;
  }
>()("t3code-relay/saas/SaasAccounts") {}

type PlanRow = typeof saasPlans.$inferSelect;
type UsageRow = typeof saasUsage.$inferSelect;

const toPlan = (row: PlanRow): SaasPlan => ({
  id: row.id,
  name: row.name,
  monthlyTokenLimit: row.monthlyTokenLimit,
  priceCents: row.priceCents,
  stripePriceId: row.stripePriceId,
  isDefault: row.isDefault,
  sortOrder: row.sortOrder,
  agenticEnabled: row.agenticEnabled,
  dailyChatLimit: row.dailyChatLimit,
});

const toUsage = (period: string, row: UsageRow | undefined): SaasUsage =>
  row === undefined
    ? emptyUsage(period)
    : {
        period,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        requests: row.requests,
      };

const parseLimit = (stored: string | undefined) => {
  const value = stored === undefined ? Number.NaN : Number(stored);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_ANONYMOUS_DAILY_CHAT_LIMIT;
};

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const settingsKey = yield* SaasCrypto.SaasSettingsKey;

  const persist =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new SaasPersistenceError({ operation, cause })));

  const loadPlans = db
    .select()
    .from(saasPlans)
    .orderBy(asc(saasPlans.sortOrder), asc(saasPlans.id))
    .pipe(
      persist("load-plans"),
      Effect.map((rows) => rows.map(toPlan)),
    );

  const defaultPlan = Effect.fn("relay.saas.default_plan")(function* () {
    const plans = yield* loadPlans;
    const plan = plans.find((candidate) => candidate.isDefault) ?? plans[0];
    if (plan === undefined) {
      return yield* new SaasPersistenceError({ operation: "default-plan", cause: "No plans" });
    }
    return plan;
  });

  const loadUsage = Effect.fn("relay.saas.load_usage")(function* (userId: string) {
    const period = usagePeriod(yield* DateTime.now);
    const rows = yield* db
      .select()
      .from(saasUsage)
      .where(and(eq(saasUsage.userId, userId), eq(saasUsage.period, period)))
      .limit(1)
      .pipe(persist("load-usage"));
    return toUsage(period, rows[0]);
  });

  const hasActiveKey = Effect.fn("relay.saas.has_active_key")(function* (userId: string) {
    const rows = yield* db
      .select({ keyHash: saasLlmKeys.keyHash })
      .from(saasLlmKeys)
      .where(and(eq(saasLlmKeys.userId, userId), isNull(saasLlmKeys.revokedAt)))
      .limit(1)
      .pipe(persist("load-llm-key"));
    return rows.length > 0;
  });

  const loadAccountView = Effect.fn("relay.saas.load_account_view")(function* (
    account: typeof saasAccounts.$inferSelect,
  ) {
    const plans = yield* loadPlans;
    const plan =
      plans.find((candidate) => candidate.id === account.planId) ?? (yield* defaultPlan());
    return {
      userId: account.userId,
      email: account.email,
      plan,
      usage: yield* loadUsage(account.userId),
      hasLlmKey: yield* hasActiveKey(account.userId),
    } satisfies SaasAccountView;
  });

  const getAccount: SaasAccounts["Service"]["getAccount"] = Effect.fn("relay.saas.get_account")(
    function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const plan = yield* defaultPlan();
      // Keeps an existing plan, and refreshes the email Clerk reports.
      const rows = yield* db
        .insert(saasAccounts)
        .values({
          userId: input.userId,
          email: input.email,
          planId: plan.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: saasAccounts.userId,
          set: { email: sql`coalesce(excluded.email, ${saasAccounts.email})` },
        })
        .returning()
        .pipe(persist("upsert-account"));
      const account = rows[0];
      if (account === undefined) {
        return yield* new SaasPersistenceError({ operation: "upsert-account", cause: "No row" });
      }
      return yield* loadAccountView(account);
    },
  );

  const createLlmKey: SaasAccounts["Service"]["createLlmKey"] = Effect.fn(
    "relay.saas.create_llm_key",
  )(function* (userId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const apiKey = SaasCrypto.generateLlmApiKey();
    const keyHash = yield* SaasCrypto.hashLlmApiKey(apiKey);
    yield* db
      .insert(saasLlmKeys)
      .values({ keyHash, userId, createdAt: now })
      .pipe(persist("insert-llm-key"));
    return apiKey;
  });

  const resolveLlmKey: SaasAccounts["Service"]["resolveLlmKey"] = Effect.fn(
    "relay.saas.resolve_llm_key",
  )(function* (apiKey) {
    if (!SaasCrypto.isLlmApiKey(apiKey)) return Option.none();
    const keyHash = yield* SaasCrypto.hashLlmApiKey(apiKey);
    const rows = yield* db
      .select({ account: saasAccounts })
      .from(saasLlmKeys)
      .innerJoin(saasAccounts, eq(saasAccounts.userId, saasLlmKeys.userId))
      .where(and(eq(saasLlmKeys.keyHash, keyHash), isNull(saasLlmKeys.revokedAt)))
      .limit(1)
      .pipe(persist("resolve-llm-key"));
    const account = rows[0]?.account;
    return account === undefined ? Option.none() : Option.some(yield* loadAccountView(account));
  });

  const recordUsage: SaasAccounts["Service"]["recordUsage"] = Effect.fn("relay.saas.record_usage")(
    function* (input) {
      const period = usagePeriod(yield* DateTime.now);
      yield* db
        .insert(saasUsage)
        .values({
          userId: input.userId,
          period,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          requests: 1,
        })
        .onConflictDoUpdate({
          target: [saasUsage.userId, saasUsage.period],
          set: {
            inputTokens: sql`${saasUsage.inputTokens} + ${input.inputTokens}`,
            outputTokens: sql`${saasUsage.outputTokens} + ${input.outputTokens}`,
            requests: sql`${saasUsage.requests} + 1`,
          },
        })
        .pipe(persist("record-usage"));
    },
  );

  const listUsers: SaasAccounts["Service"]["listUsers"] = Effect.gen(function* () {
    const period = usagePeriod(yield* DateTime.now);
    const accounts = yield* db
      .select()
      .from(saasAccounts)
      .orderBy(desc(saasAccounts.createdAt))
      .limit(500)
      .pipe(persist("list-accounts"));
    const usageRows =
      accounts.length === 0
        ? []
        : yield* db
            .select()
            .from(saasUsage)
            .where(
              and(
                eq(saasUsage.period, period),
                inArray(
                  saasUsage.userId,
                  accounts.map((account) => account.userId),
                ),
              ),
            )
            .pipe(persist("list-usage"));
    const usageByUser = new Map(usageRows.map((row) => [row.userId, row]));
    return accounts.map((account) => ({
      userId: account.userId,
      email: account.email,
      planId: account.planId,
      subscriptionStatus: account.subscriptionStatus,
      usage: toUsage(period, usageByUser.get(account.userId)),
      createdAt: account.createdAt,
    }));
  }).pipe(Effect.withSpan("relay.saas.list_users"));

  const setUserPlan: SaasAccounts["Service"]["setUserPlan"] = Effect.fn("relay.saas.set_user_plan")(
    function* (input) {
      const plans = yield* loadPlans;
      if (!plans.some((plan) => plan.id === input.planId)) {
        return yield* new SaasPlanNotFound({ planId: input.planId });
      }
      const updated = yield* db
        .update(saasAccounts)
        .set({ planId: input.planId, updatedAt: DateTime.formatIso(yield* DateTime.now) })
        .where(eq(saasAccounts.userId, input.userId))
        .returning({ userId: saasAccounts.userId })
        .pipe(persist("set-user-plan"));
      if (updated.length === 0) return yield* new SaasUserNotFound({ userId: input.userId });
    },
  );

  const savePlan: SaasAccounts["Service"]["savePlan"] = Effect.fn("relay.saas.save_plan")(
    function* (plan) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const values = {
        name: plan.name,
        monthlyTokenLimit: plan.monthlyTokenLimit,
        priceCents: plan.priceCents,
        stripePriceId: plan.stripePriceId,
        isDefault: plan.isDefault,
        sortOrder: plan.sortOrder,
        agenticEnabled: plan.agenticEnabled,
        dailyChatLimit: plan.dailyChatLimit,
        updatedAt: now,
      };
      if (plan.isDefault) {
        yield* db
          .update(saasPlans)
          .set({ isDefault: false })
          .where(eq(saasPlans.isDefault, true))
          .pipe(persist("clear-default-plan"));
      }
      yield* db
        .insert(saasPlans)
        .values({ id: plan.id, createdAt: now, ...values })
        .onConflictDoUpdate({ target: saasPlans.id, set: values })
        .pipe(persist("save-plan"));
      return plan;
    },
  );

  const readSettings = Effect.fn("relay.saas.read_settings")(function* () {
    const rows = yield* db.select().from(saasSettings).pipe(persist("load-settings"));
    return new Map(rows.map((row) => [row.key, row.value]));
  });

  const getSettings: SaasAccounts["Service"]["getSettings"] = Effect.gen(function* () {
    const settings = yield* readSettings();
    return {
      deepseekKeyConfigured: (settings.get(DEEPSEEK_KEY_SETTING) ?? "") !== "",
      deepseekModel: settings.get(DEEPSEEK_MODEL_SETTING) ?? DEFAULT_DEEPSEEK_MODEL,
      anonymousDailyChatLimit: parseLimit(settings.get(ANONYMOUS_CHAT_LIMIT_SETTING)),
    };
  });

  const writeSetting = Effect.fn("relay.saas.write_setting")(function* (
    key: string,
    value: string,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(saasSettings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: saasSettings.key, set: { value, updatedAt } })
      .pipe(persist("save-setting"));
  });

  const saveSettings: SaasAccounts["Service"]["saveSettings"] = Effect.fn(
    "relay.saas.save_settings",
  )(function* (input) {
    if (input.deepseekApiKey !== undefined) {
      const trimmed = input.deepseekApiKey.trim();
      yield* writeSetting(
        DEEPSEEK_KEY_SETTING,
        trimmed === "" ? "" : yield* SaasCrypto.encryptSetting(settingsKey, trimmed),
      );
    }
    if (input.deepseekModel !== undefined) {
      yield* writeSetting(DEEPSEEK_MODEL_SETTING, input.deepseekModel);
    }
    if (input.anonymousDailyChatLimit !== undefined) {
      yield* writeSetting(ANONYMOUS_CHAT_LIMIT_SETTING, String(input.anonymousDailyChatLimit));
    }
    return yield* getSettings;
  });

  const getModelAccess: SaasAccounts["Service"]["getModelAccess"] = Effect.gen(function* () {
    const settings = yield* readSettings();
    const stored = settings.get(DEEPSEEK_KEY_SETTING) ?? "";
    return {
      apiKey:
        stored === ""
          ? null
          : Redacted.make(
              yield* SaasCrypto.decryptSetting(settingsKey, stored).pipe(
                persist("decrypt-model-key"),
              ),
            ),
      model: settings.get(DEEPSEEK_MODEL_SETTING) ?? DEFAULT_DEEPSEEK_MODEL,
    };
  });

  const getStripeCustomerId: SaasAccounts["Service"]["getStripeCustomerId"] = Effect.fn(
    "relay.saas.get_stripe_customer_id",
  )(function* (userId) {
    const rows = yield* db
      .select({ customerId: saasAccounts.stripeCustomerId })
      .from(saasAccounts)
      .where(eq(saasAccounts.userId, userId))
      .limit(1)
      .pipe(persist("load-stripe-customer"));
    return rows[0]?.customerId ?? null;
  });

  const setStripeCustomerId: SaasAccounts["Service"]["setStripeCustomerId"] = Effect.fn(
    "relay.saas.set_stripe_customer_id",
  )(function* (input) {
    yield* db
      .update(saasAccounts)
      .set({
        stripeCustomerId: input.customerId,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .where(eq(saasAccounts.userId, input.userId))
      .pipe(persist("save-stripe-customer"));
  });

  const applySubscription: SaasAccounts["Service"]["applySubscription"] = Effect.fn(
    "relay.saas.apply_subscription",
  )(function* (input) {
    const plans = yield* loadPlans;
    const paidPlan =
      input.priceId === null
        ? undefined
        : plans.find((plan) => plan.stripePriceId === input.priceId);
    const planId =
      isLiveSubscriptionStatus(input.status) && paidPlan !== undefined
        ? paidPlan.id
        : (yield* defaultPlan()).id;
    yield* db
      .update(saasAccounts)
      .set({
        planId,
        stripeSubscriptionId: input.subscriptionId,
        subscriptionStatus: input.status,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .where(eq(saasAccounts.stripeCustomerId, input.customerId))
      .pipe(persist("apply-subscription"));
  });

  return SaasAccounts.of({
    getStripeCustomerId,
    setStripeCustomerId,
    applySubscription,
    getAccount,
    createLlmKey,
    resolveLlmKey,
    recordUsage,
    listUsers,
    setUserPlan,
    listPlans: loadPlans,
    savePlan,
    getSettings,
    saveSettings,
    getModelAccess,
  });
});

export const layer = Layer.effect(SaasAccounts, make);
