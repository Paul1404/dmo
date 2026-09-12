ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "issuer" text;--> statement-breakpoint
UPDATE "accounts" SET "account_id" = "user_id" WHERE "provider_id" = 'credential' AND "account_id" <> "user_id";--> statement-breakpoint
UPDATE "accounts" SET "issuer" = CASE WHEN "provider_id" = 'credential' THEN 'local:credential' ELSE 'local:oauth:' || "provider_id" END WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_issuer_account_id_uidx" ON "accounts" USING btree ("issuer","account_id");
