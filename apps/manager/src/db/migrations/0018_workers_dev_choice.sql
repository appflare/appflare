ALTER TABLE `installs` ADD `workers_dev_choice` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `resources` ADD `live_at` integer;--> statement-breakpoint
UPDATE `resources` SET `live_at` = `created_at`
WHERE `kind` = 'domain' AND `cf_id` IS NOT NULL AND `deleted_at` IS NULL;--> statement-breakpoint
UPDATE `resources` SET `live_at` = `created_at`
WHERE `kind` = 'custom_hostname' AND `deleted_at` IS NULL AND (
  EXISTS (
    SELECT 1 FROM `settings`
    WHERE `settings`.`key` = 'external_domain_state:' || `resources`.`id`
      AND json_valid(`settings`.`value`)
      AND json_extract(`settings`.`value`, '$.state') = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM `installs`
    WHERE `installs`.`id` = `resources`.`install_id`
      AND `installs`.`served_domain` = `resources`.`name`
  )
);--> statement-breakpoint
UPDATE `installs` SET `workers_dev_choice` = 'manual'
WHERE `workers_dev_enabled` = 0 OR EXISTS (
  SELECT 1 FROM `resources`
  WHERE `resources`.`install_id` = `installs`.`id`
    AND `resources`.`kind` IN ('domain', 'custom_hostname')
    AND `resources`.`deleted_at` IS NULL
);
