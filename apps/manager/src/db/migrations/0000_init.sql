CREATE TABLE `catalog_revisions` (
	`artifact_digest` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`sha256` text NOT NULL,
	`key_id` text NOT NULL,
	`signature` text NOT NULL,
	`catalog_json` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalogs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`colour` text NOT NULL,
	`index_url` text NOT NULL,
	`keys_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`added_at` integer NOT NULL,
	`refreshed_at` integer,
	`refresh_error` text
);
--> statement-breakpoint
CREATE TABLE `featured_dismissals` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `github_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`repositories` text,
	`for_builds` integer DEFAULT true NOT NULL,
	`for_releases` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `installs` (
	`id` text PRIMARY KEY NOT NULL,
	`app_slug` text NOT NULL,
	`worker_name` text NOT NULL,
	`instance_name` text,
	`display_name` text,
	`catalog_version` text NOT NULL,
	`artifact_url` text NOT NULL,
	`artifact_digest` text,
	`pin_sha` text,
	`status` text NOT NULL,
	`current_version_id` text,
	`config_json` text,
	`manifest_json` text,
	`do_migration_tag` text,
	`build_kind` text DEFAULT 'artifact' NOT NULL,
	`sandbox_image` text,
	`built_at` integer,
	`origin` text DEFAULT 'catalog' NOT NULL,
	`source_url` text,
	`source_ref` text,
	`health_status` text,
	`health_checked_at` integer,
	`auto_update` text DEFAULT 'inherit' NOT NULL,
	`auto_update_waiting` text,
	`workers_dev_enabled` integer DEFAULT true NOT NULL,
	`workers_dev_choice` text DEFAULT 'auto' NOT NULL,
	`served_domain` text,
	`worker_versions_json` text,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`uninstalled_at` integer,
	`forgotten_at` integer,
	`catalog_id` text
);
--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_id_idx` ON `job_logs` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`workflow_instance_id` text,
	`input_json` text,
	`error` text,
	`worker_version_id` text,
	`promoting_version` text,
	`started_by` text DEFAULT 'admin' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`reported_at` integer,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_install_id_idx` ON `jobs` (`install_id`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`kind` text NOT NULL,
	`binding` text,
	`name` text NOT NULL,
	`cf_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`retained_at` integer,
	`managed_by` text DEFAULT 'appflare' NOT NULL,
	`live_at` integer,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `resources_install_id_idx` ON `resources` (`install_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
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
	`build_kind` text DEFAULT 'artifact' NOT NULL,
	`sandbox_image` text,
	`built_at` integer,
	`origin` text DEFAULT 'catalog' NOT NULL,
	`source_url` text,
	`source_ref` text,
	`target_catalog_version` text,
	`config_json` text,
	`worker_versions_json` text,
	`hyperdrive_json` text,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_install_id_idx` ON `snapshots` (`install_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `notification_events_dedupe_key_unique` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer,
	`is_owner` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_single_owner_idx` ON `user` (`is_owner`) WHERE "is_owner" = true;--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);