import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
mkdirSync(config.backupDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  admin_role_id TEXT,
  mod_role_id TEXT,
  log_channel_id TEXT,
  verified_role_id TEXT,
  verify_channel_id TEXT,
  welcome_channel_id TEXT,
  welcome_message TEXT,
  leave_channel_id TEXT,
  leave_message TEXT,
  ticket_category_id TEXT,
  ticket_log_channel_id TEXT,
  anti_spam_enabled INTEGER DEFAULT 0,
  anti_spam_threshold INTEGER DEFAULT 5,
  anti_spam_window_ms INTEGER DEFAULT 7000,
  anti_link_enabled INTEGER DEFAULT 0,
  anti_link_whitelist TEXT DEFAULT '[]',
  raid_protection_enabled INTEGER DEFAULT 0,
  raid_join_threshold INTEGER DEFAULT 10,
  raid_window_ms INTEGER DEFAULT 10000,
  raid_action TEXT DEFAULT 'lock'
);

CREATE TABLE IF NOT EXISTS verified_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS pending_verifications (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  answer INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  opener_id TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT
);

CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  message_id TEXT,
  channel_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_buttons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  panel_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'Primary',
  emoji TEXT,
  action_type TEXT NOT NULL,
  action_value TEXT NOT NULL,
  FOREIGN KEY (panel_id) REFERENCES panels(id)
);

CREATE TABLE IF NOT EXISTS economy (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  role_id TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shop_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  FOREIGN KEY (item_id) REFERENCES shop_items(id)
);

CREATE TABLE IF NOT EXISTS shop_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  stock_id INTEGER,
  price_paid INTEGER NOT NULL,
  purchased_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS join_log (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL
);
`);

export function getGuildConfig(guildId: string) {
  const row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId) as any;
  if (row) return row;
  db.prepare('INSERT INTO guild_config (guild_id) VALUES (?)').run(guildId);
  return db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId) as any;
}

export function updateGuildConfig(guildId: string, fields: Record<string, unknown>) {
  getGuildConfig(guildId); // ensure row exists
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(`UPDATE guild_config SET ${setClause} WHERE guild_id = ?`).run(...values, guildId);
}
