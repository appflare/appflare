CREATE TABLE `github_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`repositories` text NOT NULL,
	`for_releases` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
