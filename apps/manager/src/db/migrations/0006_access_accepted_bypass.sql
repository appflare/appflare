ALTER TABLE `install_access` ADD `accepted_bypass_json` text;--> statement-breakpoint
-- Apps protected before this column existed keep the public paths they have:
-- those of the newest catalog revision recorded for their release, else those
-- of the release itself.
UPDATE `install_access` SET `accepted_bypass_json` = COALESCE(
  CASE
    WHEN EXISTS (SELECT 1 FROM `installs` i JOIN `catalog_revisions` r ON r.`artifact_digest` = i.`artifact_digest` WHERE i.`id` = `install_access`.`install_id`)
    THEN (SELECT json_extract(r.`catalog_json`, '$.access.bypass') FROM `installs` i JOIN `catalog_revisions` r ON r.`artifact_digest` = i.`artifact_digest` WHERE i.`id` = `install_access`.`install_id`)
    ELSE (SELECT json_extract(i.`manifest_json`, '$.catalog.access.bypass') FROM `installs` i WHERE i.`id` = `install_access`.`install_id`)
  END,
  '[]'
) WHERE `access_app_id` IS NOT NULL;
