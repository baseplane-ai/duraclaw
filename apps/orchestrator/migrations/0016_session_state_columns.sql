-- spec #37: collapse per-session live state onto agent_sessions row.
-- Adds 5 columns mirrored from DO-owned state; drops message_count
-- (superseded by num_turns).
ALTER TABLE `agent_sessions` ADD COLUMN `error` TEXT;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD COLUMN `error_code` TEXT;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD COLUMN `kata_state_json` TEXT;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD COLUMN `context_usage_json` TEXT;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD COLUMN `worktree_info_json` TEXT;
--> statement-breakpoint
ALTER TABLE `agent_sessions` DROP COLUMN `message_count`;
