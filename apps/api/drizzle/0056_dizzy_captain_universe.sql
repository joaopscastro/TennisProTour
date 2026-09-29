CREATE TABLE "manager_entry_activity" (
	"manager_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"player_id" text NOT NULL,
	"tournament_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manager_entry_activity_manager_id_season_week_pk" PRIMARY KEY("manager_id","season","week")
);
--> statement-breakpoint
ALTER TABLE "manager_entry_activity" ADD CONSTRAINT "manager_entry_activity_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_entry_activity" ADD CONSTRAINT "manager_entry_activity_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;