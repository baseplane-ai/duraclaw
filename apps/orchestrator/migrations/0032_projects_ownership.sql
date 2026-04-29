-- GH#122 P1.1: per-project ownership and member ACL.
--
-- Adds (B-SCHEMA-1) projects.projectId for the sha256(originUrl).slice(0,16)
-- handle the orchestrator's gateway-sync handler now derives in a single
-- D1 transaction (B-SYNC-2). Adds (B-SCHEMA-2) projectMetadata.ownerId for
-- single-owner ACL with FK to users(id) ON DELETE SET NULL — losing a user
-- reverts their projects to unowned, never cascades and orphans docs config.
-- Adds (B-SCHEMA-3) project_members with a partial unique index that lets
-- the role enum reserve editor/viewer slots while v1 only writes 'owner'.
--
-- Pre-flight: take a D1 backup with
--   wrangler d1 export duraclaw-auth --output=apps/orchestrator/migrations/backups/pre-0032.sql
-- BEFORE applying this migration. Rollback fixture; see backups/README.md.
--
-- After migration applies, operator runs `pnpm backfill:project-ids` once
-- to populate projects.projectId for rows whose projectMetadata.originUrl
-- already exists. Subsequent gateway syncs (within 30s) populate any
-- remaining rows via the atomic dual-write in B-SYNC-2.
--
-- Journal drift note: meta/_journal.json only has entries through 0017.
-- Migrations 0018-0031 shipped without journal entries; we do not
-- regenerate the journal here to avoid touching every prior migration.

-- 1. B-SCHEMA-1: projectId on projects (nullable so migration can land
--    before backfill populates it).
ALTER TABLE projects ADD COLUMN projectId TEXT;
--> statement-breakpoint
CREATE INDEX idx_projects_project_id ON projects(projectId) WHERE projectId IS NOT NULL;
--> statement-breakpoint

-- 2. B-SCHEMA-2: ownerId on projectMetadata. Inline FK because SQLite
--    cannot ADD CONSTRAINT after the fact (same pattern as 0027's
--    agent_sessions.worktreeId).
ALTER TABLE projectMetadata ADD COLUMN ownerId TEXT REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 3. B-SCHEMA-3: project_members junction. Composite PK (project_id, user_id);
--    role CHECK enforces the enum; the partial unique index enforces single
--    owner per project.
CREATE TABLE project_members (
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  added_at   TEXT NOT NULL,
  added_by   TEXT,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projectMetadata(projectId) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)                  ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_members_one_owner ON project_members(project_id) WHERE role='owner';
--> statement-breakpoint
CREATE INDEX idx_project_members_user ON project_members(user_id);
