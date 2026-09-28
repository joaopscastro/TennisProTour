ALTER TABLE "tournaments" ADD COLUMN "singles_started" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: any tournament whose singles competition has genuinely begun
-- already has singles match rows (main or qualifying), or a crowned
-- singles champion. Everything else — including a tournament whose only
-- bracket is DOUBLES — reads false, which is exactly the registration-open
-- state the column means. (Old archived match rows may be gone for
-- long-finished events; those are well past registration and are never
-- offered anyway.)
UPDATE "tournaments" SET "singles_started" = true
WHERE EXISTS (SELECT 1 FROM "tournament_matches" m WHERE m."tournament_id" = "tournaments"."id")
   OR EXISTS (SELECT 1 FROM "titles" t WHERE t."tournament_id" = "tournaments"."id");