CREATE TABLE "training_schedule" (
	"player_id" text NOT NULL,
	"effective_from_season" integer NOT NULL,
	"effective_from_week" integer NOT NULL,
	"focus_kind" "training_focus_kind",
	"focus_surface" "surface",
	"focus_attribute" "trainable_attribute",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_schedule_player_id_effective_from_season_effective_from_week_pk" PRIMARY KEY("player_id","effective_from_season","effective_from_week")
);
--> statement-breakpoint
ALTER TABLE "training_schedule" ADD CONSTRAINT "training_schedule_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN "training_focus_kind";--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN "training_focus_surface";--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN "training_focus_attribute";