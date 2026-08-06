CREATE TYPE "public"."manager_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "managers" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_subject" text NOT NULL,
	"display_name" text NOT NULL,
	"public_handle" text NOT NULL,
	"status" "manager_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managers_auth_subject_unique" UNIQUE("auth_subject"),
	CONSTRAINT "managers_public_handle_unique" UNIQUE("public_handle")
);
