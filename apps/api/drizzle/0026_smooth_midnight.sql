CREATE TABLE "manager_ladder" (
	"manager_id" text PRIMARY KEY NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_manager_ladder_score" ON "manager_ladder" USING btree ("score");