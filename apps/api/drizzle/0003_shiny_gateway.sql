ALTER TABLE "users" ADD COLUMN "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_owner_uq" ON "users" USING btree ("is_owner") WHERE "users"."is_owner";--> statement-breakpoint
-- An existing deployment's owner is the administrator it was bootstrapped with: the earliest one.
UPDATE "users" SET "is_owner" = true WHERE "id" = (SELECT "id" FROM "users" WHERE "role" = 'ADMIN' AND "deleted_at" IS NULL ORDER BY "created_at" LIMIT 1);
