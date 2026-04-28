-- GH#119 P2: agent_sessions.identity_name — record which runner
-- identity owns the session. Populated by the DO at
-- triggerGatewayDial time after LRU selection from
-- runner_identities. Broadcast to clients via broadcastSessionRow so
-- the UI can display the active identity (P4 admin sidebar surface).
ALTER TABLE agent_sessions ADD COLUMN identity_name TEXT;
