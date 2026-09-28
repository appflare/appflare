-- Rebuilds github_tokens with a nullable repositories description (a token may
-- name none) and a for_builds use. Every existing token was tried for builds, so
-- each keeps that use, its description and its release-download mark. No table
-- references github_tokens, so the rebuild needs no foreign-key pragma (D1
-- applies the batch as one transaction).
CREATE TABLE `__new_github_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`repositories` text,
	`for_builds` integer DEFAULT true NOT NULL,
	`for_releases` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_github_tokens`("id", "label", "repositories", "for_builds", "for_releases", "created_at", "last_used_at") SELECT "id", "label", "repositories", true, "for_releases", "created_at", "last_used_at" FROM `github_tokens`;--> statement-breakpoint
DROP TABLE `github_tokens`;--> statement-breakpoint
ALTER TABLE `__new_github_tokens` RENAME TO `github_tokens`;
