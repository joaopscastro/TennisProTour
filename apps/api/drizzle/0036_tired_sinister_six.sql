ALTER TABLE "doubles_peak_rankings" DROP CONSTRAINT "doubles_peak_rankings_pkey";--> statement-breakpoint
ALTER TABLE "doubles_peak_rankings" ADD COLUMN "band" "ranking_band" DEFAULT 'senior' NOT NULL;--> statement-breakpoint
ALTER TABLE "doubles_peak_rankings" ADD CONSTRAINT "doubles_peak_rankings_player_id_band_pk" PRIMARY KEY("player_id","band");--> statement-breakpoint
ALTER TABLE "doubles_titles" ADD COLUMN "age_band" "age_band";
