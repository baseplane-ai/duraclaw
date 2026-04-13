-- Add role-based access control columns for Better Auth admin plugin
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN ban_reason TEXT;
ALTER TABLE users ADD COLUMN ban_expires INTEGER;
ALTER TABLE sessions ADD COLUMN impersonated_by TEXT;
