CREATE TABLE `catalog_revisions` (
	`artifact_digest` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`sha256` text NOT NULL,
	`key_id` text NOT NULL,
	`signature` text NOT NULL,
	`catalog_json` text NOT NULL,
	`recorded_at` integer NOT NULL
);
