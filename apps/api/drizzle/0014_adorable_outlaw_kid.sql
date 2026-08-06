CREATE TYPE "public"."ranking_band" AS ENUM('senior', 'u14', 'u16');--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "dormant_carryover_target_band" "ranking_band";--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "dormant_carryover_bonus_points" double precision;