CREATE TABLE `install_access` (
	`install_id` text PRIMARY KEY NOT NULL,
	`access_app_id` text,
	`probes_policy_id` text,
	`token_id` text NOT NULL,
	`token_client_id` text NOT NULL,
	`token_secret` text NOT NULL,
	`token_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action
);
