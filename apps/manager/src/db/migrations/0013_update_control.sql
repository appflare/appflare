ALTER TABLE `installs` ADD `auto_update` text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE `installs` ADD `auto_update_waiting` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `workers_dev_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `installs` ADD `served_domain` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `started_by` text DEFAULT 'admin' NOT NULL;