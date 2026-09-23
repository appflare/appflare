-- Rebuilds snapshots with a nullable install_id. No table references snapshots,
-- so the rebuild needs no foreign-key pragma (D1 applies the batch as one transaction).
CREATE TABLE `__new_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text,
	`job_id` text NOT NULL,
	`worker_version_id` text NOT NULL,
	`d1_bookmarks_json` text NOT NULL,
	`taken_at` integer NOT NULL,
	`catalog_version` text,
	`manifest_json` text,
	`artifact_url` text,
	`artifact_digest` text,
	`pin_sha` text,
	`do_migration_tag` text,
	`target_catalog_version` text,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_snapshots`("id", "install_id", "job_id", "worker_version_id", "d1_bookmarks_json", "taken_at", "catalog_version", "manifest_json", "artifact_url", "artifact_digest", "pin_sha", "do_migration_tag", "target_catalog_version") SELECT "id", "install_id", "job_id", "worker_version_id", "d1_bookmarks_json", "taken_at", "catalog_version", "manifest_json", "artifact_url", "artifact_digest", "pin_sha", "do_migration_tag", "target_catalog_version" FROM `snapshots`;--> statement-breakpoint
DROP TABLE `snapshots`;--> statement-breakpoint
ALTER TABLE `__new_snapshots` RENAME TO `snapshots`;--> statement-breakpoint
CREATE INDEX `snapshots_install_id_idx` ON `snapshots` (`install_id`);