-- GH#152 P1: destructive contract phase of the expand-then-contract
-- migration that moves session visibility onto arcs.
--
-- Authored alongside 0036_arc_collab_acl.sql but committed as a
-- SEPARATE file so it can be deployed in a later cycle, AFTER 0036
-- has been verified in production: post-deploy spot-check confirms
-- every arcs row has a non-NULL visibility (the backfill in 0036
-- statement 6 succeeded for all rows). Splitting eliminates the
-- data-loss path where a single 10-statement migration partially
-- applies (D1 has no DDL transaction; see Gotcha #4 in spec line 953).
--
-- Pre-condition (enforced by migration-test.ts against a snapshot of
-- production data, not inline DDL — D1 has no assertion DDL):
--   SELECT COUNT(*) FROM arcs WHERE visibility IS NULL  MUST be 0
-- If non-zero, halt the deploy and re-run the 0036 backfill before
-- attempting 0038.
--
-- Renumbered from spec's 0036 → 0038 (cascading from the 0034 → 0036
-- rename of the expand phase; 0037 is reserved for P3's chat_mirror).
--
-- D1 transaction caveat: same as 0036 — DDL auto-commits, statements
-- separated by `--> statement-breakpoint`. This migration only has two
-- statements, but the marker keeps the per-statement boundary explicit
-- for the wrangler runner.

-- 1. Drop the now-redundant column. Visibility is sourced from
--    arcs.visibility from this point on; every read site MUST have
--    been migrated by the time this lands (verified app-side via
--    Drizzle schema removal in the same PR as 0036).
ALTER TABLE agent_sessions DROP COLUMN visibility;
--> statement-breakpoint

-- 2. Drop the supporting index (now references a missing column;
--    SQLite would error on the next ALTER if we left it). IF EXISTS
--    so a partial replay of this migration on dev D1s without the
--    index is non-fatal.
DROP INDEX IF EXISTS idx_agent_sessions_visibility_last_activity;
