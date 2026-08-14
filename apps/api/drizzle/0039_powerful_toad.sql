CREATE TABLE "world_team_cups" (
	"id" text PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"week_scheduled_season" integer NOT NULL,
	"week_scheduled_week" integer NOT NULL,
	"surface" "surface" NOT NULL,
	"teams" jsonb NOT NULL,
	"groups" jsonb NOT NULL,
	"knockout" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_team_cups_season_unique" UNIQUE("season")
);
