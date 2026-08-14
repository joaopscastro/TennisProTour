CREATE TABLE "masters_cups" (
	"id" text PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"week_scheduled_season" integer NOT NULL,
	"week_scheduled_week" integer NOT NULL,
	"surface" "surface" NOT NULL,
	"singles_entrants" jsonb NOT NULL,
	"doubles_entrants" jsonb NOT NULL,
	"singles_groups" jsonb NOT NULL,
	"doubles_groups" jsonb NOT NULL,
	"singles_knockout" jsonb NOT NULL,
	"doubles_knockout" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "masters_cups_season_unique" UNIQUE("season")
);
