CREATE TABLE "analytics_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"manager_id" text,
	"name" text NOT NULL,
	"dedupe_key" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "idx_analytics_events_name_created_at" ON "analytics_events" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX "idx_analytics_events_manager_created_at" ON "analytics_events" USING btree ("manager_id","created_at");