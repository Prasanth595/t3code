CREATE TABLE "saas_accounts" (
	"user_id" varchar(191) PRIMARY KEY,
	"email" text,
	"plan_id" varchar(64) NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"subscription_status" varchar(32),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saas_llm_keys" (
	"key_hash" varchar(64) PRIMARY KEY,
	"user_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"revoked_at" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "saas_plans" (
	"id" varchar(64) PRIMARY KEY,
	"name" text NOT NULL,
	"monthly_token_limit" bigint NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"stripe_price_id" varchar(255),
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saas_settings" (
	"key" varchar(64) PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saas_usage" (
	"user_id" varchar(191),
	"period" varchar(7),
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "saas_usage_pkey" PRIMARY KEY("user_id","period")
);
--> statement-breakpoint
CREATE INDEX "idx_saas_llm_keys_user_id" ON "saas_llm_keys" ("user_id");--> statement-breakpoint
INSERT INTO "saas_plans" ("id", "name", "monthly_token_limit", "price_cents", "stripe_price_id", "is_default", "sort_order", "created_at", "updated_at") VALUES
	('free', 'Free', 1000000, 0, NULL, true, 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'),
	('pro', 'Pro', 20000000, 0, NULL, false, 1, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z');
