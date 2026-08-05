CREATE TYPE "public"."player_potential_tier" AS ENUM('limited', 'promising', 'high', 'elite');--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "potential_ceiling" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "talent_pool_candidates" ADD COLUMN "potential_ceiling" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "talent_pool_candidates" ADD COLUMN "potential_tier" "player_potential_tier" NOT NULL;