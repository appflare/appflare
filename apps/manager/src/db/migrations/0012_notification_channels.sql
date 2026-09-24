CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`target` text NOT NULL,
	`config` text NOT NULL,
	`events_json` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_failure_at` integer,
	`last_success_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`event_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `channel_id`),
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_due_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_channel_idx` ON `notification_deliveries` (`channel_id`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`facts_json` text NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_key_unique` ON `notification_events` (`dedupe_key`);