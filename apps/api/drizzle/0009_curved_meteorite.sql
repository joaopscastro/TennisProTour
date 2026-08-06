CREATE TABLE "manager_progression" (
	"manager_id" text PRIMARY KEY NOT NULL,
	"xp_balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
