CREATE TABLE "manager_rankings" (
	"manager_id" text PRIMARY KEY NOT NULL,
	"total_points" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
