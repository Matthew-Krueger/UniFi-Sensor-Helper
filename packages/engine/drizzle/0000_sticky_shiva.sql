CREATE TABLE `latch_state` (
	`latch_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`armed_at` integer,
	`fired_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `latches` (
	`id` text PRIMARY KEY NOT NULL,
	`sensor_id` text NOT NULL,
	`metric` text NOT NULL,
	`direction` text NOT NULL,
	`arm_threshold` real NOT NULL,
	`clear_threshold` real NOT NULL,
	`duration_seconds` integer NOT NULL,
	`webhook_json` text NOT NULL,
	`resolved_webhook_json` text,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `protect_consoles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sensors` (
	`id` text PRIMARY KEY NOT NULL,
	`console_id` text NOT NULL,
	`name` text NOT NULL,
	`discovered_metrics` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);