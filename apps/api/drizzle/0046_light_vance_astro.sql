ALTER TYPE "public"."age_band" ADD VALUE 'u18';--> statement-breakpoint
ALTER TYPE "public"."ranking_band" ADD VALUE 'u18';--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "season_age_anchor_weeks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill every pre-existing row: treat "now" as this player's most
-- recent January 1 (a reasonable default absent any real history of
-- past season boundaries — see Player.seasonAgeAnchorWeeks' doc
-- comment and schema.ts's column comment). Every row created after
-- this migration always gets a real value from the application layer
-- (hire()/generateFillOnly() set it explicitly), so this UPDATE only
-- ever touches rows that predate the column.
UPDATE "players" SET "season_age_anchor_weeks" = "age_in_weeks";