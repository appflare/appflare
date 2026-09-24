ALTER TABLE `user` ADD `is_owner` integer DEFAULT false;--> statement-breakpoint
UPDATE `user` SET `is_owner` = true WHERE `id` = (SELECT `id` FROM `user` WHERE (',' || replace(coalesce(`role`, ''), ' ', '') || ',') LIKE '%,admin,%' ORDER BY `created_at` ASC, `id` ASC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM `user` WHERE `is_owner` = true);--> statement-breakpoint
CREATE UNIQUE INDEX `user_single_owner_idx` ON `user` (`is_owner`) WHERE `is_owner` = true;
