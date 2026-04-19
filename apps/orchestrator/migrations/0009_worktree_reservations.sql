-- worktree_reservations — chain-level worktree checkout for GH#16 P2 (3E).
-- audit_log — generic per-user audit trail; first user is force-release.

CREATE TABLE `worktree_reservations` (
	`worktree` text PRIMARY KEY NOT NULL,
	`issue_number` integer NOT NULL,
	`owner_id` text NOT NULL,
	`held_since` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`mode_at_checkout` text NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_wt_res_issue` ON `worktree_reservations` (`issue_number`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`user_id` text NOT NULL,
	`details` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_log` (`action`,`created_at`);
