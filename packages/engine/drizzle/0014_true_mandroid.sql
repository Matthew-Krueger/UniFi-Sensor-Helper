PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_latches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`sensor_id` text NOT NULL,
	`metric` text NOT NULL,
	`condition_json` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`webhook_json` text NOT NULL,
	`resolved_webhook_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`sensor_id`) REFERENCES `sensors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_latches`("id", "name", "sensor_id", "metric", "condition_json", "duration_seconds", "webhook_json", "resolved_webhook_json", "enabled") SELECT "id", "name", "sensor_id", "metric", "condition_json", "duration_seconds", "webhook_json", "resolved_webhook_json", "enabled" FROM `latches`;--> statement-breakpoint
DROP TABLE `latches`;--> statement-breakpoint
ALTER TABLE `__new_latches` RENAME TO `latches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `latches_sensor_id_idx` ON `latches` (`sensor_id`);--> statement-breakpoint
CREATE TABLE `__new_webhook_deliveries` (
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
	`dispatched_at` integer NOT NULL,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_webhook_deliveries`("id", "latch_id", "kind", "url", "method", "ok", "status", "error", "response_body_snippet", "attempts", "dispatched_at") SELECT "id", "latch_id", "kind", "url", "method", "ok", "status", "error", "response_body_snippet", "attempts", "dispatched_at" FROM `webhook_deliveries`;--> statement-breakpoint
DROP TABLE `webhook_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_webhook_deliveries` RENAME TO `webhook_deliveries`;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_latch_id_dispatched_at_idx` ON `webhook_deliveries` (`latch_id`,`dispatched_at`);--> statement-breakpoint
CREATE TABLE `__new_latch_state` (
	`latch_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`armed_at` integer,
	`fired_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_latch_state`("latch_id", "state", "armed_at", "fired_at", "updated_at") SELECT "latch_id", "state", "armed_at", "fired_at", "updated_at" FROM `latch_state`;--> statement-breakpoint
DROP TABLE `latch_state`;--> statement-breakpoint
ALTER TABLE `__new_latch_state` RENAME TO `latch_state`;--> statement-breakpoint
CREATE TABLE `__new_sensors` (
	`id` text PRIMARY KEY NOT NULL,
	`console_id` text NOT NULL,
	`name` text NOT NULL,
	`discovered_metrics` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`console_id`) REFERENCES `protect_consoles`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_sensors`("id", "console_id", "name", "discovered_metrics") SELECT "id", "console_id", "name", "discovered_metrics" FROM `sensors`;--> statement-breakpoint
DROP TABLE `sensors`;--> statement-breakpoint
ALTER TABLE `__new_sensors` RENAME TO `sensors`;