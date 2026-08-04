CREATE TABLE "ranking_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"tournament_id" text NOT NULL,
	"tier" "tournament_tier" NOT NULL,
	"points" double precision NOT NULL,
	"season_earned" integer NOT NULL,
	"week_earned" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ranking_ledger" ADD CONSTRAINT "ranking_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_ledger" ADD CONSTRAINT "ranking_ledger_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;