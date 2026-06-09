CREATE TABLE `bot_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`halted_date` text,
	`updated_at` integer DEFAULT 0 NOT NULL
);
