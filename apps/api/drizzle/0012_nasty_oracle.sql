CREATE TYPE "public"."age_band" AS ENUM('u14', 'u16');--> statement-breakpoint
ALTER TABLE "ranking_ledger" ALTER COLUMN "tier" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tournaments" ALTER COLUMN "tier" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."tournament_tier";--> statement-breakpoint
CREATE TYPE "public"."tournament_tier" AS ENUM('futures', 'challenger', 'tour', 'major', 'j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters');--> statement-breakpoint
ALTER TABLE "ranking_ledger" ALTER COLUMN "tier" SET DATA TYPE "public"."tournament_tier" USING "tier"::"public"."tournament_tier";--> statement-breakpoint
ALTER TABLE "tournaments" ALTER COLUMN "tier" SET DATA TYPE "public"."tournament_tier" USING "tier"::"public"."tournament_tier";--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "age_band" "age_band";