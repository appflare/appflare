CREATE TABLE `source_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`purpose` text NOT NULL,
	`origin` text NOT NULL,
	`app_slug` text,
	`repo` text NOT NULL,
	`requested_ref` text,
	`build_command_json` text,
	`status` text NOT NULL,
	`commit_sha` text,
	`ref` text,
	`version` text,
	`digest` text,
	`manifest_key` text,
	`artifact_key` text,
	`image` text,
	`manifest_json` text,
	`detected_json` text,
	`built_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_builds_install_id_idx` ON `source_builds` (`install_id`);--> statement-breakpoint
ALTER TABLE `installs` ADD `origin` text DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE `installs` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `source_ref` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `origin` text DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `source_ref` text;