CREATE TYPE "public"."skill_cluster" AS ENUM('technical', 'physical', 'mental');--> statement-breakpoint
CREATE TYPE "public"."training_focus_kind" AS ENUM('surface', 'skill');--> statement-breakpoint
CREATE TABLE "player_rankings" (
	"player_id" text PRIMARY KEY NOT NULL,
	"total_points" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "manager_rankings";--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "nationality" text DEFAULT 'XX' NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "training_focus_kind" "training_focus_kind";--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "training_focus_surface" "surface";--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "training_focus_cluster" "skill_cluster";--> statement-breakpoint
ALTER TABLE "player_rankings" ADD CONSTRAINT "player_rankings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
