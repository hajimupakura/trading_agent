CREATE TABLE `option_signals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `signal_id` varchar(32) NOT NULL,
  `underlying` enum('SPY','SPX') NOT NULL,
  `action` enum('watch','enter_call','enter_put','no_trade') NOT NULL,
  `setup` enum('opening_range','vwap_trend','none') NOT NULL,
  `confidence` int NOT NULL,
  `contract_ticker` varchar(64),
  `fingerprint` varchar(256) NOT NULL,
  `market_snapshot` text NOT NULL,
  `contract_snapshot` text,
  `reasons` text NOT NULL,
  `invalidation` text,
  `ai_review` text,
  `generated_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `option_signals_id` PRIMARY KEY(`id`),
  CONSTRAINT `option_signals_signal_id_unique` UNIQUE(`signal_id`)
);
