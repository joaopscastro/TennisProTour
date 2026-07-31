CREATE TYPE "public"."player_stage" AS ENUM('youth', 'prime', 'decline', 'retired');--> statement-breakpoint
CREATE TYPE "public"."surface" AS ENUM('clay', 'grass', 'hard', 'indoor');--> statement-breakpoint
CREATE TYPE "public"."tournament_tier" AS ENUM('junior', 'futures', 'challenger', 'tour', 'major');--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"manager_id" text,
	"age_in_weeks" integer NOT NULL,
	"stage" "player_stage" NOT NULL,
	"fatigue" integer DEFAULT 0 NOT NULL,
	"serve" integer NOT NULL,
	"forehand" integer NOT NULL,
	"backhand" integer NOT NULL,
	"volley" integer NOT NULL,
	"speed" integer NOT NULL,
	"stamina" integer NOT NULL,
	"strength" integer NOT NULL,
	"consistency" integer NOT NULL,
	"clutch" integer NOT NULL,
	"affinity_clay" integer NOT NULL,
	"affinity_grass" integer NOT NULL,
	"affinity_hard" integer NOT NULL,
	"affinity_indoor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_entries" (
	"tournament_id" text NOT NULL,
	"player_id" text NOT NULL,
	"seed" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_entries_tournament_id_player_id_pk" PRIMARY KEY("tournament_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_matches" (
	"tournament_id" text NOT NULL,
	"round_number" integer NOT NULL,
	"match_index" integer NOT NULL,
	"entrant_a" text NOT NULL,
	"entrant_b" text NOT NULL,
	"winner_id" text,
	"loser_id" text,
	"set_scores" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_matches_tournament_id_round_number_match_index_pk" PRIMARY KEY("tournament_id","round_number","match_index")
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" text PRIMARY KEY NOT NULL,
	"tier" "tournament_tier" NOT NULL,
	"surface" "surface" NOT NULL,
	"season_scheduled" integer NOT NULL,
	"week_scheduled" integer NOT NULL,
	"draw_size" integer NOT NULL,
	"has_started" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_entrant_a_players_id_fk" FOREIGN KEY ("entrant_a") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_entrant_b_players_id_fk" FOREIGN KEY ("entrant_b") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_winner_id_players_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_loser_id_players_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;