CREATE TABLE `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`type` enum('rally_detected','ark_trade','market_event','downside_risk','watchlist_update') NOT NULL,
	`severity` enum('high','medium','low') NOT NULL DEFAULT 'medium',
	`title` varchar(256) NOT NULL,
	`message` text NOT NULL,
	`metadata` text,
	`is_read` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ark_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_date` timestamp NOT NULL,
	`fund` varchar(16) NOT NULL,
	`ticker` varchar(32) NOT NULL,
	`company_name` varchar(256),
	`direction` enum('buy','sell') NOT NULL,
	`shares` int,
	`market_value` varchar(64),
	`percent_of_etf` varchar(16),
	`scraped_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ark_trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `news_articles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`content` text,
	`url` varchar(1024) NOT NULL,
	`source` varchar(128) NOT NULL,
	`published_at` timestamp NOT NULL,
	`scraped_at` timestamp NOT NULL DEFAULT (now()),
	`sentiment` enum('bullish','bearish','neutral'),
	`potential_term` enum('short','medium','long','none'),
	`ai_summary` text,
	`mentioned_stocks` text,
	`sectors` text,
	`rally_indicator` enum('strong','moderate','weak','none') DEFAULT 'none',
	CONSTRAINT `news_articles_id` PRIMARY KEY(`id`),
	CONSTRAINT `news_articles_url_unique` UNIQUE(`url`)
);
--> statement-breakpoint
CREATE TABLE `rally_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sector` enum('ai','metals','quantum','energy','chips','other') NOT NULL,
	`name` varchar(256) NOT NULL,
	`start_date` timestamp NOT NULL,
	`peak_date` timestamp,
	`description` text,
	`catalysts` text,
	`key_stocks` text,
	`performance` text,
	`status` enum('ongoing','ended','potential') NOT NULL DEFAULT 'potential',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rally_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sector_momentum` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sector` enum('ai','metals','quantum','energy','chips','other') NOT NULL,
	`date` timestamp NOT NULL,
	`momentum` enum('very_strong','strong','moderate','weak','declining') NOT NULL,
	`news_count` int NOT NULL DEFAULT 0,
	`sentiment_score` varchar(16),
	`top_stocks` text,
	`notes` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sector_momentum_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`refresh_schedule` varchar(64) NOT NULL DEFAULT '4h',
	`alert_threshold` enum('all','medium_high','high_only') NOT NULL DEFAULT 'medium_high',
	`enable_email_alerts` int NOT NULL DEFAULT 1,
	`watched_sectors` text,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_preferences_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `watchlist_stocks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`ticker` varchar(32) NOT NULL,
	`name` varchar(256),
	`is_priority` int NOT NULL DEFAULT 0,
	`added_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `watchlist_stocks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `alerts` ADD CONSTRAINT `alerts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD CONSTRAINT `user_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `watchlist_stocks` ADD CONSTRAINT `watchlist_stocks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;