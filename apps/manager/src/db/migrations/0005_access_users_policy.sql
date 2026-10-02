ALTER TABLE `install_access` ADD `users_policy_id` text;--> statement-breakpoint
ALTER TABLE `install_access` ADD `access_app_missing_at` integer;--> statement-breakpoint
-- Apps protected before this column existed reference the policy recorded then.
UPDATE `install_access` SET `users_policy_id` = (SELECT `value` FROM `settings` WHERE `key` = 'app_access_users_policy_id') WHERE `access_app_id` IS NOT NULL;
