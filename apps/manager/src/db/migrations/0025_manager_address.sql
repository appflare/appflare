CREATE TABLE `passkey_host` (
	`passkey_id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`passkey_id`) REFERENCES `passkey`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Channels that hear about Appflare's own releases also hear when its address
-- stops working; new channels start with every event anyway.
UPDATE `notification_channels`
SET `events_json` = json_insert(`events_json`, '$[#]', 'manager_address_lost')
WHERE json_valid(`events_json`)
  AND EXISTS (SELECT 1 FROM json_each(`notification_channels`.`events_json`) WHERE value = 'manager_update_available')
  AND NOT EXISTS (SELECT 1 FROM json_each(`notification_channels`.`events_json`) WHERE value = 'manager_address_lost');
