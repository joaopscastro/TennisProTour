CREATE TYPE "public"."tournament_entry_type" AS ENUM('da', 'q', 'wc');--> statement-breakpoint
ALTER TABLE "ranking_ledger" ADD COLUMN "obligatory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD COLUMN "entry_type" "tournament_entry_type" DEFAULT 'da' NOT NULL;