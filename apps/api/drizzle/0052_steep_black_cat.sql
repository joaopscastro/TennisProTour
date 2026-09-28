CREATE TYPE "public"."ranking_discipline" AS ENUM('singles', 'doubles');--> statement-breakpoint
ALTER TABLE "doubles_titles" DROP CONSTRAINT "doubles_titles_tournament_id_tournaments_id_fk";
--> statement-breakpoint
ALTER TABLE "ranking_ledger" DROP CONSTRAINT "ranking_ledger_tournament_id_tournaments_id_fk";
--> statement-breakpoint
ALTER TABLE "titles" DROP CONSTRAINT "titles_tournament_id_tournaments_id_fk";
--> statement-breakpoint
ALTER TABLE "ranking_ledger" ADD COLUMN "discipline" "ranking_discipline" DEFAULT 'singles' NOT NULL;