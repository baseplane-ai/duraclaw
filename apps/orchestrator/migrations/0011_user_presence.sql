-- user_presence — active-user presence mirror driven by UserSettingsDO
-- socket ref-counting (GH#32 phase p2a). One row per user while they have
-- at least one live WS connection to their UserSettingsDO; cleared on the
-- N→0 transition. Keyed by user_id (cascade from users).

CREATE TABLE `user_presence` (
	`user_id` text PRIMARY KEY NOT NULL,
	`first_connected_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
