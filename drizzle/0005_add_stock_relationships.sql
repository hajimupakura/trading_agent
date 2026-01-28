-- Create relationship type enum
CREATE TYPE "relationship_type" AS ENUM ('competitor', 'supplier', 'customer', 'supply_chain', 'complementary', 'sector_peer');--> statement-breakpoint

-- Create stock relationships table
CREATE TABLE "stock_relationships" (
  "id" serial PRIMARY KEY NOT NULL,
  "primary_ticker" varchar(32) NOT NULL,
  "related_ticker" varchar(32) NOT NULL,
  "relationship_type" "relationship_type" NOT NULL,
  "strength_score" integer NOT NULL,
  "description" text,
  "analysis_source" varchar(64) DEFAULT 'ai_analysis' NOT NULL,
  "last_updated" timestamp DEFAULT now() NOT NULL,
  "news_based_evidence" text,
  "historical_correlation" varchar(16),
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Create index for faster lookups
CREATE INDEX "idx_primary_ticker" ON "stock_relationships" ("primary_ticker");--> statement-breakpoint
CREATE INDEX "idx_related_ticker" ON "stock_relationships" ("related_ticker");--> statement-breakpoint
CREATE INDEX "idx_relationship_type" ON "stock_relationships" ("relationship_type");
