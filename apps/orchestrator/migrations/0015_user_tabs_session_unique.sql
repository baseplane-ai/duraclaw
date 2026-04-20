-- Dedup any live rows that already share (user_id, session_id) before
-- adding the uniqueness constraint. The POST handler's check-then-insert
-- pre-dedup was racy, so pre-existing databases may carry duplicates.
-- Keep the earliest row by (created_at, id) and soft-delete the rest —
-- matches the delete semantics used by the DELETE endpoint.
UPDATE `user_tabs`
SET `deleted_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` IN (
  SELECT `id` FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `user_id`, `session_id`
        ORDER BY `created_at` ASC, `id` ASC
      ) AS `rn`
    FROM `user_tabs`
    WHERE `deleted_at` IS NULL AND `session_id` IS NOT NULL
  ) WHERE `rn` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_tabs_live_session_uq`
  ON `user_tabs` (`user_id`, `session_id`)
  WHERE `deleted_at` IS NULL AND `session_id` IS NOT NULL;
