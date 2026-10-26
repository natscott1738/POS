CREATE TYPE "public"."credit_transaction_type" AS ENUM('CHARGE', 'PAYMENT', 'ADJUSTMENT', 'REFUND', 'VOID_REVERSAL');--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"credit_limit" bigint DEFAULT 0 NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_transaction_id" uuid NOT NULL,
	"charge_transaction_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"sale_id" uuid,
	"shift_id" uuid,
	"type" "credit_transaction_type" NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"payment_method" "payment_method",
	"reference" text,
	"note" text,
	"due_at" timestamp with time zone,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_charge_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("charge_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_account_id_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_accounts_customer_store_uq" ON "credit_accounts" USING btree ("customer_id","store_id");--> statement-breakpoint
CREATE INDEX "credit_accounts_store_balance_idx" ON "credit_accounts" USING btree ("store_id","balance");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_allocations_pair_uq" ON "credit_allocations" USING btree ("credit_transaction_id","charge_transaction_id");--> statement-breakpoint
CREATE INDEX "credit_allocations_charge_idx" ON "credit_allocations" USING btree ("charge_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_sale_charge_uq" ON "credit_transactions" USING btree ("account_id","sale_id") WHERE "credit_transactions"."type" = 'CHARGE';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_reference_uq" ON "credit_transactions" USING btree ("store_id","payment_method","reference") WHERE "credit_transactions"."reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_transactions_account_created_idx" ON "credit_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_account_due_idx" ON "credit_transactions" USING btree ("account_id","due_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_shift_idx" ON "credit_transactions" USING btree ("shift_id","created_at");--> statement-breakpoint
-- Preserve legacy account settings automatically only when one active store makes
-- the account's store unambiguous. Multi-store deployments must map these accounts
-- explicitly instead of multiplying one old global limit across every outlet.
WITH single_active_store AS (
  SELECT id
  FROM stores
  WHERE is_active = true
    AND (SELECT COUNT(*) FROM stores WHERE is_active = true) = 1
)
INSERT INTO credit_accounts (customer_id, store_id, credit_limit, balance, terms_days, is_active)
SELECT c.id, s.id, c.credit_limit, c.balance, 30, c.is_active
FROM customers c
CROSS JOIN single_active_store s
WHERE (c.credit_limit > 0 OR c.balance <> 0) AND c.deleted_at IS NULL
ON CONFLICT (customer_id, store_id) DO NOTHING;
--> statement-breakpoint
-- Keep any pre-existing one-store balance explainable in the append-only ledger.
INSERT INTO credit_transactions (account_id, store_id, type, amount, balance_after, due_at, note)
SELECT a.id, a.store_id, 'ADJUSTMENT', c.balance, c.balance,
       CASE WHEN c.balance > 0 THEN now() ELSE NULL END,
       'Imported legacy customer balance; verify before collection'
FROM credit_accounts a
JOIN customers c ON c.id = a.customer_id
WHERE c.balance <> 0;
