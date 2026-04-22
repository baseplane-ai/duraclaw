-- 0018: Soft-delete chain tabs (spec 16-chain-ux-p1-5 B1)
-- The kind:'chain' TabMeta variant has been removed. Mark any surviving
-- rows as deleted so reactive collections stop rendering them.
UPDATE user_tabs
SET deleted_at = datetime('now')
WHERE JSON_EXTRACT(meta, '$.kind') = 'chain'
  AND deleted_at IS NULL;
