-- Channels that hear when Appflare's address stops working also hear when a
-- move to a new address finishes; new channels start with every event anyway.
UPDATE `notification_channels`
SET `events_json` = json_insert(`events_json`, '$[#]', 'manager_move_finished')
WHERE json_valid(`events_json`)
  AND EXISTS (SELECT 1 FROM json_each(`notification_channels`.`events_json`) WHERE value = 'manager_address_lost')
  AND NOT EXISTS (SELECT 1 FROM json_each(`notification_channels`.`events_json`) WHERE value = 'manager_move_finished');
