-- GH#84: per-project user-editable abbrev + color overrides.
--
-- Tab strip currently derives a 2-char `abbrev` (regex heuristic) and an 8/10
-- slot `color_slot` (FNV-1a hash) from the project name / repo_origin. The
-- auto-derivation occasionally picks a letter combo the user wouldn't, and
-- two projects can hash to the same slot. These two columns let an admin
-- override either field per project; the existing derivation remains the
-- default when both are NULL.
--
-- Both columns live alongside `visibility` and are preserved across
-- gateway-sync upserts (the sync handler explicitly omits them from the
-- update set, same pattern as `visibility`).
--
-- `abbrev` is constrained client+server-side to `[A-Z0-9]{1,2}`; this DDL
-- intentionally does NOT add a CHECK constraint so the column type matches
-- the rest of the table (D1 has historically not enforced CHECK). Server
-- validates at PATCH time.
--
-- `color_slot` is an integer index into `PROJECT_COLOR_SLOTS` (10 slots
-- today). Out-of-range values fall through to the hash derivation.

ALTER TABLE projects ADD COLUMN abbrev TEXT;
ALTER TABLE projects ADD COLUMN color_slot INTEGER;
