PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_latches` (
	`id` text PRIMARY KEY NOT NULL,
	`sensor_id` text NOT NULL,
	`metric` text NOT NULL,
	`condition_json` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`webhook_json` text NOT NULL,
	`resolved_webhook_json` text,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_latches`("id", "sensor_id", "metric", "condition_json", "duration_seconds", "webhook_json", "resolved_webhook_json", "enabled") SELECT "id", "sensor_id", "metric", "condition_json", "duration_seconds", "webhook_json", "resolved_webhook_json", "enabled" FROM `latches`;--> statement-breakpoint
DROP TABLE `latches`;--> statement-breakpoint
ALTER TABLE `__new_latches` RENAME TO `latches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;