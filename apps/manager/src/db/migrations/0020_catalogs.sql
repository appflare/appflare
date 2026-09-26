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
ALTER TABLE `installs` ADD `catalog_id` text;
--> statement-breakpoint
INSERT INTO `catalogs` (`id`, `kind`, `label`, `colour`, `index_url`, `keys_json`, `enabled`, `added_at`)
VALUES (
	'official',
	'official',
	'Official',
	'orange',
	'https://appflare.github.io/catalog/index.json',
	'[{"keyId":"catalog-2026-09","publicKeyBase64":"HYmxJhxMa0jtF1nDO7yuDXxjVSm+ph6NnrXABpoDqG8="}]',
	1,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
--> statement-breakpoint
UPDATE `installs` SET `catalog_id` = 'official' WHERE `origin` <> 'repository';