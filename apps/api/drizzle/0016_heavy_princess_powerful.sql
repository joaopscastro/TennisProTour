ALTER TABLE "players" ADD COLUMN "speed_ceiling" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "stamina_ceiling" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "strength_ceiling" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "talent_pool_candidates" ADD COLUMN "speed_ceiling" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "talent_pool_candidates" ADD COLUMN "stamina_ceiling" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "talent_pool_candidates" ADD COLUMN "strength_ceiling" integer DEFAULT 100 NOT NULL;