-- Replace old KV-shape user_preferences (from 0003) with the columnar
-- shape. NOTE: D1 does not implicitly wrap multi-statement migrations in
-- a transaction, and the `--> statement-breakpoint` marker would split
-- this into independent statements. We therefore omit the breakpoint so
-- drizzle/wrangler hand both statements to a single `db.execute()` call.
-- This is NOT a true atomic transaction: D1 still executes statements
-- sequentially, so a failure on CREATE leaves the DROP applied. The
-- migration will, however, be marked failed and operators can recover by
-- fixing the CREATE and re-running — `DROP TABLE IF EXISTS` is idempotent.
DROP TABLE IF EXISTS `user_preferences`;
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`permission_mode` text DEFAULT 'default',
	`model` text DEFAULT 'claude-opus-4-6',
	`max_budget` real,
	`thinking_mode` text DEFAULT 'adaptive',
	`effort` text DEFAULT 'high',
	`hidden_projects_json` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
