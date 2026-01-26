ALTER TABLE `news_articles` ADD `isAnalyzed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `news_articles` ADD `aiSummary` text;--> statement-breakpoint
ALTER TABLE `news_articles` ADD `potentialTerm` enum('short','medium','long','none');--> statement-breakpoint
ALTER TABLE `news_articles` DROP COLUMN `potential_term`;--> statement-breakpoint
ALTER TABLE `news_articles` DROP COLUMN `ai_summary`;