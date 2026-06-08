CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`ts` integer NOT NULL,
	`price` real NOT NULL,
	`snapshot` text NOT NULL,
	`trigger` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`timeframe_bias` text DEFAULT 'neutral' NOT NULL,
	`reasoning` text DEFAULT '' NOT NULL,
	`key_factors` text DEFAULT '[]' NOT NULL,
	`stop_loss` real,
	`take_profit` text,
	`invalidation` text DEFAULT '' NOT NULL,
	`executed` integer DEFAULT 0 NOT NULL,
	`key_used` text,
	`model_used` text,
	`outcome_pnl_pct` real,
	`outcome_correct` integer,
	`evaluated_at` integer
);
--> statement-breakpoint
CREATE TABLE `market_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`order_type` text DEFAULT 'Market' NOT NULL,
	`qty` real NOT NULL,
	`price` real NOT NULL,
	`stop_loss` real,
	`take_profit` real,
	`status` text DEFAULT 'submitted' NOT NULL,
	`bybit_order_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	`exit_price` real,
	`pnl_quote` real
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`date` text NOT NULL,
	`key_index` integer NOT NULL,
	`model` text NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_requests` integer DEFAULT 0 NOT NULL,
	`last_updated` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `key_index`, `model`)
);
