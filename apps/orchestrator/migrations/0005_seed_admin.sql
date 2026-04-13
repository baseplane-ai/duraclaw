-- Promote ben@baseplane.ai to admin role
UPDATE users SET role = 'admin' WHERE email = 'ben@baseplane.ai';
