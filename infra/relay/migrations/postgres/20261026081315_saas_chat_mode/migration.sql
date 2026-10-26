CREATE TABLE "saas_chat_conversations" (
	"user_id" varchar(191),
	"id" varchar(64),
	"title" text NOT NULL,
	"messages" text NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "saas_chat_conversations_pkey" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "saas_chat_daily" (
	"subject" varchar(191),
	"day" varchar(10),
	"messages" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "saas_chat_daily_pkey" PRIMARY KEY("subject","day")
);
--> statement-breakpoint
ALTER TABLE "saas_plans" ADD COLUMN "agentic_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plans" ADD COLUMN "daily_chat_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_saas_chat_conversations_user_updated" ON "saas_chat_conversations" ("user_id","updated_at");--> statement-breakpoint
UPDATE "saas_plans" SET "agentic_enabled" = true WHERE "id" = 'pro';--> statement-breakpoint
UPDATE "saas_plans" SET "daily_chat_limit" = 200 WHERE "id" = 'free';
