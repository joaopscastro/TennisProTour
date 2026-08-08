CREATE TABLE "peak_rankings" (
	"player_id" text NOT NULL,
	"band" "ranking_band" NOT NULL,
	"peak_points" double precision NOT NULL,
	"peak_as_of_season" integer NOT NULL,
	"peak_as_of_week" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peak_rankings_player_id_band_pk" PRIMARY KEY("player_id","band")
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"tournament_id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"tier" "tournament_tier" NOT NULL,
	"age_band" "age_band",
	"season_earned" integer NOT NULL,
	"week_earned" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "peak_rankings" ADD CONSTRAINT "peak_rankings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_titles_player_id" ON "titles" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "idx_ranking_ledger_player_id" ON "ranking_ledger" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_entries_player_id" ON "tournament_entries" USING btree ("player_id");