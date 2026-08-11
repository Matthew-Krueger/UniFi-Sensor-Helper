ALTER TABLE `protect_consoles` ADD `down_alert_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `protect_consoles` ADD `down_alert_duration_seconds` integer;--> statement-breakpoint
ALTER TABLE `protect_consoles` ADD `down_alert_webhook_json` text;--> statement-breakpoint
ALTER TABLE `protect_consoles` ADD `down_alert_resolved_webhook_json` text;