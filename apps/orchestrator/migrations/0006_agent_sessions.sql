CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`model` text,
	`sdk_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_activity` text,
	`num_turns` integer,
	`prompt` text,
	`summary` text,
	`title` text,
	`tag` text,
	`origin` text DEFAULT 'duraclaw',
	`agent` text DEFAULT 'claude',
	`archived` integer DEFAULT false NOT NULL,
	`duration_ms` integer,
	`total_cost_usd` real,
	`message_count` integer,
	`kata_mode` text,
	`kata_issue` integer,
	`kata_phase` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_sessions_sdk_id` ON `agent_sessions` (`sdk_session_id`) WHERE "agent_sessions"."sdk_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_user_last_activity` ON `agent_sessions` (`user_id`,`last_activity`);--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_user_project` ON `agent_sessions` (`user_id`,`project`);
