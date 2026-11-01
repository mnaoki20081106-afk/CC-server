import type { Env } from "./types";
import { SECURITY_SCHEMA_STATEMENTS } from "./security/db";
import { BACKUP_SCHEMA_STATEMENTS } from "./backup-db";
import { MEMBER_ACTIVITY_SCHEMA_STATEMENTS } from "./member-activity";

let schemaReady = false;

// D1's env.DB.exec() splits its input on newlines and runs each line as its
// own statement, so a multi-line CREATE TABLE breaks mid-statement. Use
// batch() with one prepare() per statement instead — each is sent whole.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS dashboard_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS guild_config (
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
  )`,

  `CREATE TABLE IF NOT EXISTS panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    message_id TEXT,
    channel_id TEXT,
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS panel_buttons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    style TEXT NOT NULL DEFAULT 'Primary',
    emoji TEXT,
    action_type TEXT NOT NULL,
    action_value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS amazon_vending_config (
    guild_id TEXT PRIMARY KEY,
    panel_title TEXT NOT NULL DEFAULT 'Amazon自販機',
    panel_description TEXT DEFAULT 'Amazon商品をLTCで購入できます。',
    ltc_address TEXT,
    api_type TEXT NOT NULL DEFAULT 'rainforest',
    api_key TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS amazon_vending_sessions (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    asin TEXT NOT NULL,
    product_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS bot_guild_cache (
    guild_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    seen_at INTEGER NOT NULL
  )`,

  ...SECURITY_SCHEMA_STATEMENTS,
  ...BACKUP_SCHEMA_STATEMENTS,
  ...MEMBER_ACTIVITY_SCHEMA_STATEMENTS,
];

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA_STATEMENTS.map(sql => env.DB.prepare(sql)));
  schemaReady = true;
}

// ── dashboard sessions ────────────────────────────────────────────────────────

export async function createDashboardSession(env: Env, tokenHash: string, expiresAt: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO dashboard_sessions(token_hash,expires_at,created_at) VALUES(?,?,?)"
  ).bind(tokenHash, expiresAt, Date.now()).run();
}

export async function getDashboardSession(env: Env, tokenHash: string): Promise<{ token_hash: string; expires_at: number } | null> {
  const row = await env.DB.prepare(
    "SELECT token_hash,expires_at FROM dashboard_sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, Date.now()).first<{ token_hash: string; expires_at: number }>();
  return row ?? null;
}

export async function cleanExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM dashboard_sessions WHERE expires_at<?").bind(Date.now()).run();
}

// ── guild config ──────────────────────────────────────────────────────────────

export type GuildConfig = Record<string, unknown> & { guild_id: string };

export async function getGuildConfig(env: Env, guildId: string): Promise<GuildConfig> {
  const row = await env.DB.prepare("SELECT * FROM guild_config WHERE guild_id=?").bind(guildId).first<GuildConfig>();
  if (row) return row;
  await env.DB.prepare("INSERT INTO guild_config(guild_id) VALUES(?)").bind(guildId).run();
  return (await env.DB.prepare("SELECT * FROM guild_config WHERE guild_id=?").bind(guildId).first<GuildConfig>())!;
}

export async function updateGuildConfig(env: Env, guildId: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await getGuildConfig(env, guildId);
  const set = keys.map(k => `${k}=?`).join(",");
  const vals = keys.map(k => fields[k]);
  await env.DB.prepare(`UPDATE guild_config SET ${set} WHERE guild_id=?`).bind(...vals, guildId).run();
}

// ── panels ────────────────────────────────────────────────────────────────────

export type Panel = { id: number; guild_id: string; title: string; description: string | null; message_id: string | null; channel_id: string | null; created_by: string; created_at: number };
export type PanelButton = { id: number; panel_id: number; label: string; style: string; emoji: string | null; action_type: string; action_value: string };

export async function listPanels(env: Env, guildId: string): Promise<Panel[]> {
  const { results } = await env.DB.prepare("SELECT * FROM panels WHERE guild_id=? ORDER BY id").bind(guildId).all<Panel>();
  return results;
}

export async function createPanel(env: Env, guildId: string, title: string, description: string | null): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO panels(guild_id,title,description,created_by,created_at) VALUES(?,?,?,'admin',?)"
  ).bind(guildId, title, description, Date.now()).run();
  return Number(r.meta.last_row_id);
}

export async function getPanel(env: Env, panelId: number, guildId: string): Promise<Panel | null> {
  return env.DB.prepare("SELECT * FROM panels WHERE id=? AND guild_id=?").bind(panelId, guildId).first<Panel>();
}

export async function updatePanelPost(env: Env, panelId: number, messageId: string, channelId: string): Promise<void> {
  await env.DB.prepare("UPDATE panels SET message_id=?,channel_id=? WHERE id=?").bind(messageId, channelId, panelId).run();
}

export async function listPanelButtons(env: Env, panelId: number): Promise<PanelButton[]> {
  const { results } = await env.DB.prepare("SELECT * FROM panel_buttons WHERE panel_id=? ORDER BY id").bind(panelId).all<PanelButton>();
  return results;
}

export async function createPanelButton(env: Env, panelId: number, label: string, style: string, emoji: string | null, actionType: string, actionValue: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO panel_buttons(panel_id,label,style,emoji,action_type,action_value) VALUES(?,?,?,?,?,?)"
  ).bind(panelId, label, style, emoji, actionType, actionValue).run();
}

export async function deletePanelButton(env: Env, buttonId: number, panelId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM panel_buttons WHERE id=? AND panel_id=?").bind(buttonId, panelId).run();
}

export async function getPanelButton(env: Env, buttonId: number): Promise<PanelButton | null> {
  return env.DB.prepare("SELECT * FROM panel_buttons WHERE id=?").bind(buttonId).first<PanelButton>();
}

// ── amazon vending ────────────────────────────────────────────────────────────

export type AvConfig = { guild_id: string; panel_title: string; panel_description: string | null; ltc_address: string | null; api_type: string; api_key: string | null };

export async function getAvConfig(env: Env, guildId: string): Promise<AvConfig> {
  const row = await env.DB.prepare("SELECT * FROM amazon_vending_config WHERE guild_id=?").bind(guildId).first<AvConfig>();
  return row ?? {
    guild_id: guildId,
    panel_title: "Amazon自販機",
    panel_description: "Amazon商品をLTCで購入できます。",
    ltc_address: null,
    api_type: "rainforest",
    api_key: null,
  };
}

export async function upsertAvConfig(env: Env, cfg: AvConfig): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO amazon_vending_config(guild_id,panel_title,panel_description,ltc_address,api_type,api_key)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      panel_title=excluded.panel_title,
      panel_description=excluded.panel_description,
      ltc_address=excluded.ltc_address,
      api_type=excluded.api_type,
      api_key=excluded.api_key
  `).bind(cfg.guild_id, cfg.panel_title, cfg.panel_description, cfg.ltc_address, cfg.api_type, cfg.api_key).run();
}

export type AvSession = { id: string; guild_id: string; user_id: string; asin: string; product_json: string; created_at: number };

export async function createAvSession(env: Env, session: AvSession): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO amazon_vending_sessions(id,guild_id,user_id,asin,product_json,created_at) VALUES(?,?,?,?,?,?)"
  ).bind(session.id, session.guild_id, session.user_id, session.asin, session.product_json, session.created_at).run();
}

export async function getAvSession(env: Env, id: string): Promise<AvSession | null> {
  return env.DB.prepare("SELECT * FROM amazon_vending_sessions WHERE id=?").bind(id).first<AvSession>();
}

export async function deleteAvSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM amazon_vending_sessions WHERE id=?").bind(id).run();
}

export async function cleanExpiredAvSessions(env: Env): Promise<void> {
  const cutoff = Date.now() - 30 * 60 * 1000;
  await env.DB.prepare("DELETE FROM amazon_vending_sessions WHERE created_at<?").bind(cutoff).run();
}

// ── bot guild cache ───────────────────────────────────────────────────────────
// Discord's GET /users/@me/guilds is the only source of truth cc-server's
// Worker has (no persistent gateway connection), but it can occasionally lag
// right after an invite. Cache the last good result so a transient failure
// doesn't empty the dashboard's server list.

export type CachedBotGuild = { id: string; name: string; icon: string | null };

export async function replaceBotGuildCache(env: Env, guilds: CachedBotGuild[]): Promise<void> {
  const seenAt = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bot_guild_cache"),
    ...guilds.map(g => env.DB.prepare("INSERT INTO bot_guild_cache(guild_id,name,icon,seen_at) VALUES(?,?,?,?)").bind(g.id, g.name, g.icon, seenAt)),
  ]);
}

export async function listBotGuildCache(env: Env, maxAgeMs = 24 * 60 * 60_000): Promise<CachedBotGuild[]> {
  const { results } = await env.DB.prepare(
    "SELECT guild_id AS id, name, icon FROM bot_guild_cache WHERE seen_at>=? ORDER BY name COLLATE NOCASE"
  ).bind(Date.now() - maxAgeMs).all<CachedBotGuild>();
  return results;
}
