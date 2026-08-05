CREATE TYPE "public"."player_rarity_tier" AS ENUM('common', 'strong', 'exceptional');--> statement-breakpoint
CREATE TYPE "public"."talent_pool_candidate_status" AS ENUM('available', 'claimed', 'expired');--> statement-breakpoint
CREATE TABLE "talent_pool_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"nationality" text NOT NULL,
	"tier" "player_rarity_tier" NOT NULL,
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
	"season_generated" integer NOT NULL,
	"week_generated" integer NOT NULL,
	"status" "talent_pool_candidate_status" DEFAULT 'available' NOT NULL,
	"claimed_by_manager_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manager_entitlements" ADD COLUMN "custom_player_credits" integer DEFAULT 0 NOT NULL;