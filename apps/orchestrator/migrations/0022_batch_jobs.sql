-- Batch-analysis lane: queued LLM jobs that resolve via the Anthropic
-- Message Batches API (50% off vs sync).
--
-- Producer (POST /api/batch-jobs)  → status='queued', enqueues on
--   the BATCH_JOBS queue.
-- Queue consumer                   → flips to 'anthropic_submitted',
--   stamps `anthropic_id`.
-- Cron (every 5 min via scheduled)  → polls Anthropic, transitions
--   'in_progress' → 'completed' or 'failed', writes `result_payload`
--   or `error`.

CREATE TABLE batch_jobs (
  id              TEXT PRIMARY KEY,
  consumer        TEXT NOT NULL,        -- 'autoresearch' | 'summary' | 'kata' | …
  session_id      TEXT,                 -- nullable cross-ref to agent_sessions.id
  status          TEXT NOT NULL,        -- queued|anthropic_submitted|in_progress|completed|failed
  anthropic_id    TEXT,                 -- batch id from Anthropic
  request_payload TEXT NOT NULL,        -- JSON: model, messages, max_tokens, …
  result_payload  TEXT,                 -- JSON on completion
  error           TEXT,
  created_at      INTEGER NOT NULL,
  submitted_at    INTEGER,
  completed_at    INTEGER
);

-- Cron + producer scans.
CREATE INDEX batch_jobs_status_idx ON batch_jobs(status, created_at);
-- Cross-ref lookups when a session UI wants its pending jobs.
CREATE INDEX batch_jobs_session_idx ON batch_jobs(session_id, created_at);
