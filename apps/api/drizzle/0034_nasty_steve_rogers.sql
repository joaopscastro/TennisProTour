CREATE TABLE "doubles_peak_rankings" (
	"player_id" text PRIMARY KEY NOT NULL,
	"peak_points" double precision NOT NULL,
	"peak_as_of_season" integer NOT NULL,
	"peak_as_of_week" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doubles_titles" (
	"tournament_id" text PRIMARY KEY NOT NULL,
	"player_a" text NOT NULL,
	"player_b" text NOT NULL,
	"tier" "tournament_tier" NOT NULL,
	"season_earned" integer NOT NULL,
	"week_earned" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doubles_pairs" ADD COLUMN "chemistry" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_doubles_pairs" ADD COLUMN "chemistry" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_doubles_pairs" ADD COLUMN "persistent_pair_id" text;--> statement-breakpoint
ALTER TABLE "doubles_peak_rankings" ADD CONSTRAINT "doubles_peak_rankings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubles_titles" ADD CONSTRAINT "doubles_titles_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubles_titles" ADD CONSTRAINT "doubles_titles_player_a_players_id_fk" FOREIGN KEY ("player_a") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubles_titles" ADD CONSTRAINT "doubles_titles_player_b_players_id_fk" FOREIGN KEY ("player_b") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_doubles_titles_player_a" ON "doubles_titles" USING btree ("player_a");--> statement-breakpoint
CREATE INDEX "idx_doubles_titles_player_b" ON "doubles_titles" USING btree ("player_b");