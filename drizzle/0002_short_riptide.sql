CREATE TABLE `youtube_influencers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`channel_id` varchar(128) NOT NULL,
	`channel_name` varchar(256) NOT NULL,
	`channel_url` varchar(512),
	`is_active` int NOT NULL DEFAULT 1,
	`added_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `youtube_influencers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `youtube_videos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`influencer_id` int NOT NULL,
	`video_id` varchar(128) NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`published_at` timestamp NOT NULL,
	`thumbnail_url` varchar(512),
	`video_url` varchar(512) NOT NULL,
	`ai_summary` text,
	`key_takeaways` text,
	`mentioned_stocks` text,
	`sentiment` enum('bullish','bearish','neutral'),
	`sectors` text,
	`trading_signals` text,
	`scraped_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `youtube_videos_id` PRIMARY KEY(`id`),
	CONSTRAINT `youtube_videos_video_id_unique` UNIQUE(`video_id`)
);
--> statement-breakpoint
ALTER TABLE `rally_events` MODIFY COLUMN `sector` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `rally_events` MODIFY COLUMN `status` enum('ongoing','ended','potential','predicted') NOT NULL DEFAULT 'potential';--> statement-breakpoint
ALTER TABLE `sector_momentum` MODIFY COLUMN `sector` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `news_articles` ADD `emerging_sector` text;--> statement-breakpoint
ALTER TABLE `news_articles` ADD `prediction_confidence` int;--> statement-breakpoint
ALTER TABLE `rally_events` ADD `prediction_confidence` int;--> statement-breakpoint
ALTER TABLE `rally_events` ADD `early_signals` text;--> statement-breakpoint
ALTER TABLE `rally_events` ADD `is_historical` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sector_momentum` ADD `rally_probability` int;--> statement-breakpoint
ALTER TABLE `sector_momentum` ADD `is_emerging` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `youtube_influencers` ADD CONSTRAINT `youtube_influencers_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `youtube_videos` ADD CONSTRAINT `youtube_videos_influencer_id_youtube_influencers_id_fk` FOREIGN KEY (`influencer_id`) REFERENCES `youtube_influencers`(`id`) ON DELETE cascade ON UPDATE no action;