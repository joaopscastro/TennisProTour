CREATE TABLE "practice_sessions" (
	"player_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"day" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_sessions_player_id_season_week_day_pk" PRIMARY KEY("player_id","season","week","day")
);
--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;