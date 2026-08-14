CREATE TYPE "public"."tournament_draw" AS ENUM('main', 'qualifying');--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD COLUMN "draw" "tournament_draw" DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "draw" "tournament_draw" DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_matches" DROP CONSTRAINT "tournament_matches_tournament_id_round_number_match_index_pk";--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_draw_round_number_match_index_pk" PRIMARY KEY("tournament_id","draw","round_number","match_index");--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "qualifying_draw_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "qualifier_slots" integer DEFAULT 0 NOT NULL;
