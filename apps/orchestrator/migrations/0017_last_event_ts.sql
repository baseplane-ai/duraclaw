-- GH#50: add last_event_ts for client-side TTL status derivation.
-- Nullable; pre-migration rows fall through to server status until they
-- next receive an event and populate naturally. INTEGER (epoch ms) —
-- intentionally distinct from `last_activity` (TEXT ISO, sidebar sort).
ALTER TABLE `agent_sessions` ADD COLUMN `last_event_ts` INTEGER;
