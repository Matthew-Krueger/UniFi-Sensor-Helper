CREATE TABLE `latch_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`latch_id` text NOT NULL,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `latch_transitions_latch_id_timestamp_idx` ON `latch_transitions` (`latch_id`,`timestamp`);