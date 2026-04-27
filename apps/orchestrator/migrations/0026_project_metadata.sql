-- GH#27 P1.1: projectMetadata — per-project metadata for the
-- docs-as-Yjs dial-back runner.
--
-- One row per logical project, keyed by a 16-char SHA-based projectId.
-- `docsWorktreePath` is user-supplied (NULL until the user configures
-- a docs worktree for the project). `tombstoneGraceDays` is the
-- soft-delete retention window for docs entities under this project.
-- Column names are camelCase to match the spec's B2 task list shape;
-- this is intentional and distinct from the older snake_case tables.
CREATE TABLE IF NOT EXISTS projectMetadata (
  projectId TEXT PRIMARY KEY,
  projectName TEXT NOT NULL,
  originUrl TEXT,
  docsWorktreePath TEXT,
  tombstoneGraceDays INTEGER NOT NULL DEFAULT 7,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
