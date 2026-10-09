ALTER TABLE "backups" ADD COLUMN "offsite_key" text;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "offsite_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "offsite_error" text;