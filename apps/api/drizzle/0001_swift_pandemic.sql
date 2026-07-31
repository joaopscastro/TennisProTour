CREATE TABLE "game_worlds" (
	"id" text PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"last_applied_tick" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
