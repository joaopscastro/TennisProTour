CREATE TABLE "manager_cosmetics" (
	"manager_id" text NOT NULL,
	"item_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manager_cosmetics_manager_id_item_id_pk" PRIMARY KEY("manager_id","item_id")
);
