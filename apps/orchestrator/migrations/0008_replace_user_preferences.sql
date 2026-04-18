-- Atomic replacement: drop old KV-shape user_preferences (from 0003),
-- create columnar replacement. Wrangler applies both statements as one
-- file, so a failure on CREATE cannot leave the old table gone with no
-- replacement — either both apply or neither does.
DROP TABLE IF EXISTS `user_preferences`;
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`permission_mode` text DEFAULT 'default',
	`model` text DEFAULT 'claude-opus-4-6',
	`max_budget` real,
	`thinking_mode` text DEFAULT 'adaptive',
	`effort` text DEFAULT 'high',
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
