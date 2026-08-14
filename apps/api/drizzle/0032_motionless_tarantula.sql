CREATE TYPE "public"."doubles_pair_status" AS ENUM('pending', 'active', 'dissolved');--> statement-breakpoint
CREATE TABLE "doubles_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"player_a" text NOT NULL,
	"player_b" text NOT NULL,
	"status" "doubles_pair_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doubles_pairs" ADD CONSTRAINT "doubles_pairs_player_a_players_id_fk" FOREIGN KEY ("player_a") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubles_pairs" ADD CONSTRAINT "doubles_pairs_player_b_players_id_fk" FOREIGN KEY ("player_b") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_doubles_pairs_player_a" ON "doubles_pairs" USING btree ("player_a");--> statement-breakpoint
CREATE INDEX "idx_doubles_pairs_player_b" ON "doubles_pairs" USING btree ("player_b");