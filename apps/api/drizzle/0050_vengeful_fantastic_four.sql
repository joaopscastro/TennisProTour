CREATE TABLE "manager_notification_states" (
	"manager_id" text PRIMARY KEY NOT NULL,
	"digest_opt_out" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"manager_id" text NOT NULL,
	"kind" text NOT NULL,
	"window_key" text NOT NULL,
	"covered_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_manager_id_kind_window_key_pk" PRIMARY KEY("manager_id","kind","window_key")
);
--> statement-breakpoint
ALTER TABLE "manager_notification_states" ADD CONSTRAINT "manager_notification_states_manager_id_managers_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."managers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_manager_id_managers_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."managers"("id") ON DELETE no action ON UPDATE no action;