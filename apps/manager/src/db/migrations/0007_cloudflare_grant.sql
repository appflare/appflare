CREATE TABLE `cloudflare_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`scopes_json` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`access_expires_at` integer,
	`key_id` text NOT NULL,
	`status` text NOT NULL,
	`problem` text,
	`problem_at` integer,
	`connected_at` integer NOT NULL,
	`refreshed_at` integer NOT NULL
);
