-- fcm_subscriptions — Firebase Cloud Messaging registration tokens for the
-- Capacitor Android shell (GH#26 P1 B5). Web push (VAPID) keeps using
-- push_subscriptions; this table is opt-in per native install.

CREATE TABLE `fcm_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`platform` text DEFAULT 'android' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fcm_user_id` ON `fcm_subscriptions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fcm_token` ON `fcm_subscriptions` (`token`);
