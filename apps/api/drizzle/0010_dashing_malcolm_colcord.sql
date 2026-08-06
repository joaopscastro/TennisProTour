CREATE TABLE "coaches" (
	"id" text PRIMARY KEY NOT NULL,
	"manager_id" text NOT NULL,
	"coach_rating" integer NOT NULL,
	"source_player_id" text NOT NULL,
	"source_player_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
