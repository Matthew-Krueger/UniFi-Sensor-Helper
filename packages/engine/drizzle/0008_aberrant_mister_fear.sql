CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`latch_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`method` text NOT NULL,
	`ok` integer NOT NULL,
	`status` integer,
	`error` text,
	`response_body_snippet` text,
	`attempts` integer NOT NULL,
	`dispatched_at` integer NOT NULL
);
