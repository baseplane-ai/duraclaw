-- projects — authoritative D1 mirror of the gateway's project manifest
-- (GH#32 phase p4). Populated by POST /api/gateway/projects/sync which the
-- agent-gateway pushes after every manifest scan. `deleted_at` is set when a
-- row is present in D1 but absent from a push payload — enabling soft
-- deletion semantics so synced-collection delta frames can broadcast
-- removals without dropping history.

CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`root_path` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
