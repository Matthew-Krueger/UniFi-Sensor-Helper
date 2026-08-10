ALTER TABLE `protect_consoles` ADD `default_interval_seconds` integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `sensors` ADD `expected_interval_seconds` integer;