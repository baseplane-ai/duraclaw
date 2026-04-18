-- Replace old KV-shape user_preferences (from 0003) with the columnar
-- shape. NOTE: D1 does not implicitly wrap multi-statement migrations in
-- a transaction, and the `--> statement-breakpoint` marker would split
-- this into independent statements. We therefore omit the breakpoint so
-- drizzle/wrangler hand both statements to a single `db.execute()` call.
-- This is NOT a true atomic transaction: D1 still executes statements
-- sequentially, so a failure on CREATE leaves the DROP applied. The
-- migration will, however, be marked failed and operators can recover by
-- fixing the CREATE and re-running — `DROP TABLE IF EXISTS` is idempotent.
--
-- DATA-LOSS FOOTNOTE: The old KV-shape `user_preferences` rows from
-- migration 0003 are intentionally discarded by this migration. The
-- columnar replacement table is *not* backfilled from the old KV rows;
-- instead it is repopulated from UserSettingsDO state during cutover via
-- `scripts/export-do-state.ts` (P1.6), which is the authoritative source
-- of preference data at migration time. Consequently a CREATE failure
-- here does not lose user preference data — DO state remains intact and
-- the export script is re-runnable. A failure only means the new
-- columnar table does not yet exist; once the CREATE is fixed and the
-- migration re-applied (DROP IF EXISTS makes re-run safe), the export
-- script can hydrate it.
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
