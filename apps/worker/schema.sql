CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key,value) VALUES ('schema_version','1');
-- The Worker bootstraps all other tables automatically on first use via ensureSchema().
