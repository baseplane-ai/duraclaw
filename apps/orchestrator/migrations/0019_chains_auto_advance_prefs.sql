-- 0019: Add chains auto-advance preferences (spec 16-chain-ux-p1-5 B5)
ALTER TABLE user_preferences ADD COLUMN chains_json TEXT;
ALTER TABLE user_preferences ADD COLUMN default_chain_auto_advance INTEGER DEFAULT 0;
