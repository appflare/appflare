ALTER TABLE `installs` ADD `do_migration_tag` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `worker_version_id` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `catalog_version` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `manifest_json` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `artifact_url` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `artifact_digest` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `pin_sha` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `do_migration_tag` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `target_catalog_version` text;