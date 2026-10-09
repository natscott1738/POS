CREATE TYPE "public"."backup_status" AS ENUM('RUNNING', 'SUCCESS', 'FAILED', 'VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('PERCENTAGE', 'FIXED_AMOUNT');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'MPESA', 'PDQ', 'STORE_CREDIT', 'LOYALTY_POINTS', 'GIFT_CARD', 'BANK_TRANSFER', 'ON_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REVERSED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."qb_entity" AS ENUM('SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT', 'CREDIT_MEMO', 'ITEM', 'CUSTOMER', 'INVENTORY_ADJUSTMENT', 'JOURNAL_ENTRY');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'MANAGER', 'CASHIER', 'AUDITOR');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('DRAFT', 'PENDING_PAYMENT', 'COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('OPEN', 'CLOSED', 'RECONCILED');--> statement-breakpoint
CREATE TYPE "public"."stock_reason" AS ENUM('SALE', 'SALE_VOID', 'REFUND', 'PURCHASE_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT', 'STOCK_COUNT', 'DAMAGE', 'THEFT', 'EXPIRY', 'MANUAL_ADJUSTMENT', 'OPENING_BALANCE');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."tax_code" AS ENUM('STANDARD', 'ZERO_RATED', 'EXEMPT');--> statement-breakpoint
CREATE TYPE "public"."unit_of_measure" AS ENUM('EACH', 'KG', 'LITRE', 'METRE', 'PACK');--> statement-breakpoint
CREATE TABLE "pdq_terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"label" text NOT NULL,
	"provider" text DEFAULT 'SIMULATOR' NOT NULL,
	"acquirer" text,
	"merchant_id" text,
	"device_serial" text,
	"endpoint_url" text,
	"encrypted_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"tax_pin" text,
	"currency" text DEFAULT 'KES' NOT NULL,
	"timezone" text DEFAULT 'Africa/Nairobi' NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"cash_rounding_increment" integer DEFAULT 0 NOT NULL,
	"receipt_header" text,
	"receipt_footer" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"receipt_prefix" text NOT NULL,
	"last_receipt_sequence" integer DEFAULT 0 NOT NULL,
	"device_fingerprint" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"actor_role" text,
	"override_by_user_id" uuid,
	"store_id" uuid,
	"terminal_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"changes" text,
	"reason" text,
	"ip_address" "inet",
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"ip_address" "inet",
	"succeeded" boolean NOT NULL,
	"failure_reason" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"replaced_by_hash" text,
	"terminal_id" uuid,
	"user_agent" text,
	"ip_address" "inet",
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_stores" (
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" "role" DEFAULT 'CASHIER' NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"staff_code" text,
	"pin_hash" text,
	"mfa_secret_encrypted" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_recovery_codes" text[],
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"qb_income_account_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_price" bigint NOT NULL,
	"cost_price" bigint DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit_price" bigint NOT NULL,
	"cost_price" bigint DEFAULT 0 NOT NULL,
	"reorder_point" bigint DEFAULT 0 NOT NULL,
	"reorder_quantity" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"tax_rate_basis_points" integer DEFAULT 1600 NOT NULL,
	"tax_code" "tax_code" DEFAULT 'STANDARD' NOT NULL,
	"unit_of_measure" "unit_of_measure" DEFAULT 'EACH' NOT NULL,
	"track_inventory" boolean DEFAULT true NOT NULL,
	"axes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qb_item_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	"unit_cost" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier_name" text NOT NULL,
	"reference" text NOT NULL,
	"total_cost" bigint DEFAULT 0 NOT NULL,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity_at_trigger" bigint NOT NULL,
	"reorder_point" bigint NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity_on_hand" bigint DEFAULT 0 NOT NULL,
	"quantity_reserved" bigint DEFAULT 0 NOT NULL,
	"average_cost" bigint DEFAULT 0 NOT NULL,
	"last_counted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity_delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reason" "stock_reason" NOT NULL,
	"unit_cost" bigint,
	"reference_type" text,
	"reference_id" uuid,
	"note" text,
	"performed_by" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_customer_id" uuid,
	"full_name" text NOT NULL,
	"phone" text,
	"email" text,
	"tax_pin" text,
	"address" text,
	"date_of_birth" date,
	"notes" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"credit_limit" bigint DEFAULT 0 NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"loyalty_points" integer DEFAULT 0 NOT NULL,
	"total_spent" bigint DEFAULT 0 NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"last_visit_at" timestamp with time zone,
	"qb_customer_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"sale_id" uuid,
	"points" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"performed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid,
	"refund_id" uuid,
	"store_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'CAPTURED' NOT NULL,
	"amount" bigint NOT NULL,
	"tendered_amount" bigint,
	"change_amount" bigint DEFAULT 0 NOT NULL,
	"mpesa_transaction_id" uuid,
	"pdq_transaction_id" uuid,
	"external_reference" text,
	"masked_pan" text,
	"card_scheme" text,
	"gift_card_code" text,
	"loyalty_points" integer,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	"unit_price" bigint NOT NULL,
	"line_total" bigint NOT NULL,
	"tax_amount" bigint NOT NULL,
	"restocked" boolean DEFAULT true NOT NULL,
	"reason" text DEFAULT 'OTHER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_refund_id" uuid NOT NULL,
	"refund_number" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"shift_id" uuid,
	"processed_by" uuid NOT NULL,
	"override_by_user_id" uuid,
	"subtotal" bigint NOT NULL,
	"tax_total" bigint NOT NULL,
	"total" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_offline" boolean DEFAULT false NOT NULL,
	"refunded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"client_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"product_name" text NOT NULL,
	"variant_sku" text NOT NULL,
	"variant_label" text,
	"quantity" bigint NOT NULL,
	"unit_price" bigint NOT NULL,
	"unit_cost" bigint DEFAULT 0 NOT NULL,
	"gross_subtotal" bigint NOT NULL,
	"line_discount" bigint DEFAULT 0 NOT NULL,
	"allocated_order_discount" bigint DEFAULT 0 NOT NULL,
	"line_total" bigint NOT NULL,
	"tax_amount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"tax_code" text NOT NULL,
	"discount_type" "discount_type",
	"discount_value" integer,
	"discount_reason" text,
	"quantity_refunded" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_sale_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"shift_id" uuid,
	"cashier_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "sale_status" DEFAULT 'COMPLETED' NOT NULL,
	"gross_subtotal" bigint NOT NULL,
	"line_discount_total" bigint DEFAULT 0 NOT NULL,
	"order_discount_total" bigint DEFAULT 0 NOT NULL,
	"net_total" bigint NOT NULL,
	"tax_total" bigint NOT NULL,
	"rounding_adjustment" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"change_given" bigint DEFAULT 0 NOT NULL,
	"amount_refunded" bigint DEFAULT 0 NOT NULL,
	"order_discount_type" "discount_type",
	"order_discount_value" integer,
	"order_discount_reason" text,
	"tax_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"note" text,
	"receipt_email" text,
	"receipt_phone" text,
	"loyalty_points_earned" integer DEFAULT 0 NOT NULL,
	"loyalty_points_redeemed" integer DEFAULT 0 NOT NULL,
	"created_offline" boolean DEFAULT false NOT NULL,
	"oversold" boolean DEFAULT false NOT NULL,
	"repriced_on_sync" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"override_by_user_id" uuid,
	"sold_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_shift_id" uuid,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"status" "shift_status" DEFAULT 'OPEN' NOT NULL,
	"opening_float" bigint DEFAULT 0 NOT NULL,
	"counted_cash" bigint,
	"expected_cash" bigint,
	"cash_variance" bigint,
	"denominations" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mpesa_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"sale_id" uuid,
	"client_sale_id" uuid,
	"kind" text DEFAULT 'STK_PUSH' NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount" bigint NOT NULL,
	"phone" text NOT NULL,
	"account_reference" text NOT NULL,
	"merchant_request_id" text,
	"checkout_request_id" text,
	"confirmation_code" text,
	"result_code" integer,
	"result_description" text,
	"confirmed_amount" bigint,
	"payer_name" text,
	"transaction_date" timestamp with time zone,
	"raw_callback" jsonb,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"initiated_by" uuid,
	"expires_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"poll_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mpesa_unmatched_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"phone" text,
	"payer_name" text,
	"bill_reference" text,
	"transaction_time" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"matched_sale_id" uuid,
	"matched_at" timestamp with time zone,
	"matched_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pdq_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"pdq_terminal_id" uuid,
	"sale_id" uuid,
	"client_sale_id" uuid,
	"transaction_ref" text NOT NULL,
	"kind" text DEFAULT 'PURCHASE' NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount" bigint NOT NULL,
	"auth_code" text,
	"masked_pan" text,
	"card_scheme" text,
	"response_code" text,
	"response_message" text,
	"terminal_receipt" text,
	"raw_response" jsonb,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"settled_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"initiated_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'IN_PROGRESS' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"resource_id" uuid,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"batch_sequence" integer NOT NULL,
	"operation_count" integer NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"results" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"label" text,
	"last_batch_sequence" integer DEFAULT 0 NOT NULL,
	"last_push_at" timestamp with time zone,
	"last_pull_at" timestamp with time zone,
	"last_pulled_change_id" text,
	"registered_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"realm_id" text NOT NULL,
	"company_name" text,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"connected_by" uuid,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"entity" "qb_entity" NOT NULL,
	"local_id" uuid NOT NULL,
	"qb_id" text NOT NULL,
	"sync_token" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"income_account_id" text NOT NULL,
	"income_account_name" text NOT NULL,
	"undeposited_funds_account_id" text NOT NULL,
	"tax_code_id_standard" text,
	"tax_code_id_zero_rated" text,
	"tax_code_id_exempt" text,
	"inventory_asset_account_id" text,
	"cogs_account_id" text,
	"discount_account_id" text,
	"rounding_account_id" text,
	"payment_accounts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_customer_id" text,
	"posting_mode" text DEFAULT 'PER_SALE' NOT NULL,
	"auto_sync_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid,
	"return_to" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_sync_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"entity" "qb_entity" NOT NULL,
	"local_id" uuid NOT NULL,
	"operation" text DEFAULT 'CREATE' NOT NULL,
	"status" "sync_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_error_code" text,
	"payload_snapshot" jsonb,
	"qb_id" text,
	"request_idempotency_key" text NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'DAILY' NOT NULL,
	"status" "backup_status" DEFAULT 'RUNNING' NOT NULL,
	"filename" text NOT NULL,
	"location" text NOT NULL,
	"size_bytes" bigint,
	"checksum" text,
	"encrypted" boolean DEFAULT true NOT NULL,
	"duration_ms" integer,
	"error" text,
	"verified_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"triggered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"detail" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pdq_terminals" ADD CONSTRAINT "pdq_terminals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdq_terminals" ADD CONSTRAINT "pdq_terminals_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_override_by_user_id_users_id_fk" FOREIGN KEY ("override_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_override_by_user_id_users_id_fk" FOREIGN KEY ("override_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_override_by_user_id_users_id_fk" FOREIGN KEY ("override_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_unmatched_payments" ADD CONSTRAINT "mpesa_unmatched_payments_matched_sale_id_sales_id_fk" FOREIGN KEY ("matched_sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_unmatched_payments" ADD CONSTRAINT "mpesa_unmatched_payments_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdq_transactions" ADD CONSTRAINT "pdq_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdq_transactions" ADD CONSTRAINT "pdq_transactions_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdq_transactions" ADD CONSTRAINT "pdq_transactions_pdq_terminal_id_pdq_terminals_id_fk" FOREIGN KEY ("pdq_terminal_id") REFERENCES "public"."pdq_terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdq_transactions" ADD CONSTRAINT "pdq_transactions_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdq_transactions" ADD CONSTRAINT "pdq_transactions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_devices" ADD CONSTRAINT "sync_devices_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_devices" ADD CONSTRAINT "sync_devices_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_devices" ADD CONSTRAINT "sync_devices_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_connections" ADD CONSTRAINT "qb_connections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_connections" ADD CONSTRAINT "qb_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_entity_links" ADD CONSTRAINT "qb_entity_links_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_mappings" ADD CONSTRAINT "qb_mappings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_mappings" ADD CONSTRAINT "qb_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_oauth_states" ADD CONSTRAINT "qb_oauth_states_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_oauth_states" ADD CONSTRAINT "qb_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_sync_queue" ADD CONSTRAINT "qb_sync_queue_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pdq_terminals_store_idx" ON "pdq_terminals" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_scope_key_uq" ON "settings" USING btree ("store_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_code_uq" ON "stores" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "terminals_store_code_uq" ON "terminals" USING btree ("store_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "terminals_receipt_prefix_uq" ON "terminals" USING btree ("receipt_prefix");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_idx" ON "login_attempts" USING btree ("identifier","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_stores_pk" ON "user_stores" USING btree ("user_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_staff_code_uq" ON "users" USING btree ("staff_code");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "price_history_variant_idx" ON "price_history" USING btree ("variant_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_sku_uq" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_barcode_uq" ON "product_variants" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_active_idx" ON "products" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_receipt_idx" ON "goods_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_store_idx" ON "goods_receipts" USING btree ("store_id","received_at");--> statement-breakpoint
CREATE INDEX "stock_alerts_open_idx" ON "stock_alerts" USING btree ("store_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_alerts_active_uq" ON "stock_alerts" USING btree ("store_id","variant_id","kind") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_store_variant_uq" ON "stock_levels" USING btree ("store_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_levels_variant_idx" ON "stock_levels" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_idx" ON "stock_movements" USING btree ("store_id","variant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_reference_idx" ON "stock_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "stock_movements_occurred_idx" ON "stock_movements" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_phone_uq" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_client_id_uq" ON "customers" USING btree ("client_customer_id");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "loyalty_tx_customer_idx" ON "loyalty_transactions" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_tx_expiry_idx" ON "loyalty_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payments_sale_idx" ON "payments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "payments_refund_idx" ON "payments" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "payments_store_method_idx" ON "payments" USING btree ("store_id","method","captured_at");--> statement-breakpoint
CREATE INDEX "payments_external_ref_idx" ON "payments" USING btree ("external_reference");--> statement-breakpoint
CREATE INDEX "refund_lines_refund_idx" ON "refund_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_lines_sale_line_idx" ON "refund_lines" USING btree ("sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_client_id_uq" ON "refunds" USING btree ("client_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_number_uq" ON "refunds" USING btree ("refund_number");--> statement-breakpoint
CREATE INDEX "refunds_sale_idx" ON "refunds" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "refunds_store_date_idx" ON "refunds" USING btree ("store_id","refunded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_lines_sale_client_uq" ON "sale_lines" USING btree ("sale_id","client_line_id");--> statement-breakpoint
CREATE INDEX "sale_lines_sale_idx" ON "sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_lines_variant_idx" ON "sale_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_client_id_uq" ON "sales" USING btree ("client_sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_receipt_number_uq" ON "sales" USING btree ("receipt_number");--> statement-breakpoint
CREATE INDEX "sales_store_sold_idx" ON "sales" USING btree ("store_id","sold_at");--> statement-breakpoint
CREATE INDEX "sales_cashier_idx" ON "sales" USING btree ("cashier_id","sold_at");--> statement-breakpoint
CREATE INDEX "sales_customer_idx" ON "sales" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sales_shift_idx" ON "sales" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "sales_status_idx" ON "sales" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_client_id_uq" ON "shifts" USING btree ("client_shift_id");--> statement-breakpoint
CREATE INDEX "shifts_terminal_status_idx" ON "shifts" USING btree ("terminal_id","status");--> statement-breakpoint
CREATE INDEX "shifts_store_opened_idx" ON "shifts" USING btree ("store_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mpesa_checkout_request_uq" ON "mpesa_transactions" USING btree ("checkout_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mpesa_confirmation_code_uq" ON "mpesa_transactions" USING btree ("confirmation_code");--> statement-breakpoint
CREATE INDEX "mpesa_sale_idx" ON "mpesa_transactions" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "mpesa_client_sale_idx" ON "mpesa_transactions" USING btree ("client_sale_id");--> statement-breakpoint
CREATE INDEX "mpesa_status_idx" ON "mpesa_transactions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "mpesa_phone_idx" ON "mpesa_transactions" USING btree ("phone","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mpesa_unmatched_txid_uq" ON "mpesa_unmatched_payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "mpesa_unmatched_open_idx" ON "mpesa_unmatched_payments" USING btree ("matched_sale_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pdq_transaction_ref_uq" ON "pdq_transactions" USING btree ("transaction_ref");--> statement-breakpoint
CREATE INDEX "pdq_sale_idx" ON "pdq_transactions" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pdq_status_idx" ON "pdq_transactions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pdq_store_date_idx" ON "pdq_transactions" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "change_log_store_id_idx" ON "change_log" USING btree ("store_id","id");--> statement-breakpoint
CREATE INDEX "change_log_entity_idx" ON "change_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_uq" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_batches_device_seq_uq" ON "sync_batches" USING btree ("device_id","batch_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_devices_device_uq" ON "sync_devices" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sync_devices_store_idx" ON "sync_devices" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_connections_store_uq" ON "qb_connections" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "qb_connections_realm_idx" ON "qb_connections" USING btree ("realm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_entity_links_local_uq" ON "qb_entity_links" USING btree ("store_id","entity","local_id");--> statement-breakpoint
CREATE INDEX "qb_entity_links_qb_idx" ON "qb_entity_links" USING btree ("store_id","entity","qb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_mappings_store_uq" ON "qb_mappings" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_oauth_states_state_uq" ON "qb_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_queue_entity_local_uq" ON "qb_sync_queue" USING btree ("store_id","entity","local_id","operation");--> statement-breakpoint
CREATE INDEX "qb_queue_ready_idx" ON "qb_sync_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "qb_queue_store_idx" ON "qb_sync_queue" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "backups_started_idx" ON "backups" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "backups_status_idx" ON "backups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("name","started_at");