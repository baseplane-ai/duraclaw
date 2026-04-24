-- GH#76 P4: delete lastEventTs TTL infrastructure.
-- Status is now derived from messagesCollection (active sessions) or the
-- D1-mirrored `status` column (list views); the TTL predicate is retired.
ALTER TABLE agent_sessions DROP COLUMN last_event_ts;
