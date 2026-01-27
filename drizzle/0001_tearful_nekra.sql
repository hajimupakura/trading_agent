CREATE TYPE "public"."backtest_status" AS ENUM('pending', 'processing', 'completed');--> statement-breakpoint
CREATE TYPE "public"."prediction_outcome" AS ENUM('success', 'failure', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."user_defined_alert_status" AS ENUM('active', 'triggered', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."user_defined_alert_type" AS ENUM('price_above', 'price_below', 'volume_increase');--> statement-breakpoint
CREATE TABLE "stock_financials" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" varchar(32) NOT NULL,
	"market_cap" varchar(64),
	"pe_ratio" varchar(32),
	"eps" varchar(32),
	"dividend_yield" varchar(32),
	"beta" varchar(32),
	"high_52_week" varchar(32),
	"low_52_week" varchar(32),
	"last_updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_financials_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "stock_historical_candles" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" varchar(32) NOT NULL,
	"resolution" varchar(8) NOT NULL,
	"open" text,
	"high" text,
	"low" text,
	"close" text,
	"volume" text,
	"timestamp" text,
	"from" integer NOT NULL,
	"to" integer NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_defined_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ticker" varchar(32) NOT NULL,
	"type" "user_defined_alert_type" NOT NULL,
	"value" varchar(64) NOT NULL,
	"status" "user_defined_alert_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"triggered_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "prediction_outcome" "prediction_outcome";--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "backtest_status" "backtest_status" DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "initial_prices" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "options_strategy" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "suggested_strike" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "suggested_expiration" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "entry_strategy" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "exit_strategy" text;--> statement-breakpoint
ALTER TABLE "rally_events" ADD COLUMN "risk_assessment" text;--> statement-breakpoint
ALTER TABLE "user_defined_alerts" ADD CONSTRAINT "user_defined_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;