ALTER TABLE "order_items" ADD COLUMN "restocked_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stock_decision_at" timestamp with time zone;