-- Rename "google" provider to "gmail" for clarity (Google Calendar gets its own provider).
UPDATE app_connections SET provider = 'gmail' WHERE provider = 'google';
UPDATE app_configs SET provider = 'gmail' WHERE provider = 'google';