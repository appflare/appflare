ALTER TABLE `install_access` ADD `access_resync_due_at` integer;--> statement-breakpoint
-- Apps protected before their Access application named their hostnames next to
-- their Workers: the cron's Access resync brings each one in step once, so an
-- Access application someone made for a broader pattern (`*.<subdomain>.workers.dev`,
-- `*.example.com`) stops deciding who reaches them. Nothing failed, so their pages
-- show nothing for it; an app whose last sync failed is retried anyway. One
-- whose Access application was deleted is left out: protecting it again
-- makes a new application with every hostname.
UPDATE `install_access` SET `access_resync_due_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `access_app_id` IS NOT NULL AND `access_sync_failed_at` IS NULL
  AND `access_app_missing_at` IS NULL;
