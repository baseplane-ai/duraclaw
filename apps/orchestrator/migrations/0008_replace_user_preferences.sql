-- Replace old KV-shape user_preferences (from 0003) with the columnar
-- shape. The old table is RENAMED to `user_preferences_legacy` (not
-- dropped) so its rows survive this migration in case cutover needs to
-- be inspected or rolled back. The columnar replacement is then created
-- fresh under the original name.
--
-- NOTE: D1 does not implicitly wrap multi-statement migrations in a
-- transaction, and the `--> statement-breakpoint` marker would split
-- this into independent statements. We therefore omit the breakpoint so
-- drizzle/wrangler hand both statements to a single `db.execute()` call.
-- This is NOT a true atomic transaction: D1 still executes statements
-- sequentially, so a failure on CREATE leaves the RENAME applied. In
-- that case both tables can coexist briefly — the legacy rename is
-- preserved, and there is no new `user_preferences` yet. Operators
-- recover by fixing the CREATE, dropping any partial new
-- `user_preferences` if one exists, and re-running the migration. The
-- legacy table itself is removed by the follow-up migration 0009 only
-- after operators have verified the columnar replacement is hydrated
-- correctly.
--
-- DATA-LOSS FOOTNOTE: The columnar replacement table is *not* backfilled
-- automatically from the legacy KV rows; instead it is repopulated from
-- UserSettingsDO state during cutover via `scripts/export-do-state.ts`
-- (P1.6), which is the authoritative source of preference data at
-- migration time. The renamed `user_preferences_legacy` table is kept
-- around as a safety net so the old KV rows remain inspectable until
-- 0009 drops it post-verification.
ALTER TABLE `user_preferences` RENAME TO `user_preferences_legacy`;
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
