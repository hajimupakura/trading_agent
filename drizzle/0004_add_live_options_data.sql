-- Add live market data fields to rally_events for options trading recommendations
ALTER TABLE "rally_events" ADD COLUMN "option_premium" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "option_greeks" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "current_stock_price" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "break_even_price" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "probability_of_profit" integer;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "open_interest" integer;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "implied_volatility" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "options_data_fetched_at" timestamp;
