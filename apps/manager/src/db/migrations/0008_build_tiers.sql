ALTER TABLE `installs` ADD `build_kind` text DEFAULT 'artifact' NOT NULL;--> statement-breakpoint
ALTER TABLE `installs` ADD `sandbox_image` text;--> statement-breakpoint
ALTER TABLE `installs` ADD `built_at` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `managed_by` text DEFAULT 'appflare' NOT NULL;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `build_kind` text DEFAULT 'artifact' NOT NULL;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `sandbox_image` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `built_at` integer;