ALTER TYPE "public"."trainable_attribute" ADD VALUE 'doubles';--> statement-breakpoint
CREATE TABLE "tournament_doubles_entrants" (
	"tournament_id" text NOT NULL,
	"player_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_doubles_entrants_tournament_id_player_id_pk" PRIMARY KEY("tournament_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_doubles_matches" (
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
	CONSTRAINT "tournament_doubles_matches_tournament_id_round_number_match_index_pk" PRIMARY KEY("tournament_id","round_number","match_index")
);
--> statement-breakpoint
CREATE TABLE "tournament_doubles_pairs" (
	"tournament_id" text NOT NULL,
	"pair_id" text NOT NULL,
	"player_a" text NOT NULL,
	"player_b" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_doubles_pairs_tournament_id_pair_id_pk" PRIMARY KEY("tournament_id","pair_id")
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "doubles" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "doubles_draw_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_doubles_entrants" ADD CONSTRAINT "tournament_doubles_entrants_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_doubles_entrants" ADD CONSTRAINT "tournament_doubles_entrants_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_doubles_matches" ADD CONSTRAINT "tournament_doubles_matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_doubles_pairs" ADD CONSTRAINT "tournament_doubles_pairs_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_doubles_pairs" ADD CONSTRAINT "tournament_doubles_pairs_player_a_players_id_fk" FOREIGN KEY ("player_a") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_doubles_pairs" ADD CONSTRAINT "tournament_doubles_pairs_player_b_players_id_fk" FOREIGN KEY ("player_b") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;