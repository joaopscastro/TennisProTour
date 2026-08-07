-- Hand-written, not drizzle-kit-generated: renaming skill_cluster (3
-- values) to trainable_attribute (7 different values, unrelated names)
-- makes drizzle-kit's enum-rename-vs-create resolver ask an interactive
-- question with no non-interactive flag to answer it. Written to match
-- the exact SQL drizzle-kit itself would emit for this sequence of
-- schema.ts changes.

-- No existing row can have a valid single-attribute equivalent for the
-- old cluster-level focus (which cluster's specific attribute would
-- 'technical' or 'physical' become?) — clear any such standing focus
-- back to "unset" rather than guessing one. Defensive: as of this
-- migration, no live row actually has training_focus_kind = 'skill',
-- but this keeps the migration correct against any environment where
-- one might.
UPDATE "players" SET "training_focus_kind" = NULL, "training_focus_surface" = NULL, "training_focus_cluster" = NULL WHERE "training_focus_kind" = 'skill';--> statement-breakpoint
ALTER TYPE "public"."training_focus_kind" RENAME VALUE 'skill' TO 'attribute';--> statement-breakpoint
CREATE TYPE "public"."trainable_attribute" AS ENUM('serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength');--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "training_focus_attribute" "trainable_attribute";--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN "training_focus_cluster";--> statement-breakpoint
DROP TYPE "public"."skill_cluster";
