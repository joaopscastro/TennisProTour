-- Backfill-safe: existing pre-feature rows (seeded before
-- TournamentNameGenerator existed) get a clearly-flagged placeholder so
-- the NOT NULL constraint can be enforced without data loss; every row
-- created from this point forward always has a real generated name
-- (see OpenTournamentUseCase/OpenRegistrationUseCase).
ALTER TABLE "tournaments" ADD COLUMN "name" text;
UPDATE "tournaments" SET "name" = 'Legacy Tournament ' || "id" WHERE "name" IS NULL;
ALTER TABLE "tournaments" ALTER COLUMN "name" SET NOT NULL;
