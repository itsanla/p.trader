CREATE TABLE `equity_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`equity_usd` real NOT NULL,
	`breakdown` text
);
