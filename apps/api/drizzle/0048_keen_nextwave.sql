CREATE TABLE "weekly_entry_claims" (
	"player_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"is_junior" boolean NOT NULL,
	"tournament_id" text NOT NULL,
	CONSTRAINT "weekly_entry_claims_player_id_season_week_is_junior_tournament_id_pk" PRIMARY KEY("player_id","season","week","is_junior","tournament_id")
);
--> statement-breakpoint
ALTER TABLE "weekly_entry_claims" ADD CONSTRAINT "weekly_entry_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_entry_claims" ADD CONSTRAINT "weekly_entry_claims_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;