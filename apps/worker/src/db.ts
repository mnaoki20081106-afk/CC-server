import type { DashboardSession, Env, GuildSettings, PaymentRow, ProductRow, SessionRow } from "./types";

export const DEFAULT_SETTINGS: GuildSettings = {
  securityEnabled: true,
  antiSpam: true,
  spamMax: 6,
  spamWindowSeconds: 8,
  blockInvites: true,
  mentionLimit: 6,
  antiRaid: true,
  raidJoins: 10,
  raidWindowSeconds: 20,
  antiNuke: true,
  nukeActions: 4,
  nukeWindowSeconds: 15,
  logChannelId: null,
  verifiedRoleId: null,
  minAccountAgeDays: 3,
  ticketSupportRoleIds: [],
  trustedUserIds: [],
  trustedRoleIds: []
};

const schema = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '5');

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_yen INTEGER NOT NULL CHECK (price_yen > 0),
  active INTEGER NOT NULL DEFAULT 1,
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('role','text')),
  role_id TEXT,
  delivery_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS products_guild_idx ON products(guild_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_payment_id TEXT UNIQUE NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  paypay_url TEXT,
  amount_yen INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments(status, delivered_at, created_at);

CREATE TABLE IF NOT EXISTS verification_challenges (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_cursors (
  guild_id TEXT PRIMARY KEY,
  last_entry_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_guild_cache (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_guild_cache_seen_idx ON bot_guild_cache(seen_at);

CREATE TABLE IF NOT EXISTS bot_guild_membership (
  guild_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_guild_membership_seen_idx ON bot_guild_membership(seen_at);

-- Amazon自販機 (CC-server)
CREATE TABLE IF NOT EXISTS amazon_vending_config (
  guild_id TEXT PRIMARY KEY,
  panel_title TEXT NOT NULL DEFAULT 'Amazon自販機',
  panel_description TEXT DEFAULT 'Amazon商品をLTCで購入できます。',
  ltc_address TEXT,
  api_type TEXT NOT NULL DEFAULT 'rainforest',
  api_key TEXT
);

CREATE TABLE IF NOT EXISTS amazon_vending_sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  product_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS amazon_vending_orders (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  product_title TEXT NOT NULL,
  price_jpy INTEGER NOT NULL,
  image_url TEXT,
  review_posted_at INTEGER,
  review_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS amazon_vending_orders_guild_idx ON amazon_vending_orders(guild_id, created_at);

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
`;

const schemaInitializations = new WeakMap<D1Database, Promise<void>>();
export async function ensureSchema(env: Env): Promise<void> {
  let initialization = schemaInitializations.get(env.DB);
  if (!initialization) {
    initialization = (async () => {
      // D1 exec splits on newlines, including those inside CREATE TABLE.
      // This static DDL contains no semicolons in literals or triggers.
      const statements = schema.split(";").map(sql => sql.trim()).filter(Boolean);
      await env.DB.batch([
        ...statements.map(sql => env.DB.prepare(sql)),
        env.DB.prepare(`
          INSERT INTO meta(key, value) VALUES ('schema_version', '5')
          ON CONFLICT(key) DO UPDATE SET value='5'
        `)
      ]);
      await migrateAmazonVendingSchema(env);
    })();
    schemaInitializations.set(env.DB, initialization);
    initialization.catch(() => schemaInitializations.delete(env.DB));
  }
  await initialization;
}

export async function cleanExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM verification_challenges WHERE expires_at < ?").bind(now)
  ]);
}

export async function putOAuthState(env: Env, state: string): Promise<void> {
  await env.DB.prepare("INSERT INTO oauth_states(state, expires_at) VALUES (?, ?)")
    .bind(state, Date.now() + 10 * 60_000).run();
}

export async function consumeOAuthState(env: Env, state: string): Promise<boolean> {
  const now = Date.now();
  const found = await env.DB.prepare(
    "SELECT state FROM oauth_states WHERE state=? AND expires_at>?"
  ).bind(state, now).first();
  if (!found) return false;
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  return true;
}

export async function createSession(env: Env, row: SessionRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO web_sessions(
      token_hash,user_id,username,avatar,access_token_enc,refresh_token_enc,
      token_expires_at,expires_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    row.token_hash,row.user_id,row.username,row.avatar,row.access_token_enc,
    row.refresh_token_enc,row.token_expires_at,row.expires_at,Date.now()
  ).run();
}

export async function getSession(env: Env, tokenHash: string): Promise<SessionRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM web_sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, Date.now()).first<SessionRow>() ?? null;
}

export async function updateSessionTokens(
  env: Env,
  tokenHash: string,
  accessEnc: string,
  refreshEnc: string,
  expiresAt: number
): Promise<void> {
  await env.DB.prepare(`
    UPDATE web_sessions
    SET access_token_enc=?, refresh_token_enc=?, token_expires_at=?
    WHERE token_hash=?
  `).bind(accessEnc, refreshEnc, expiresAt, tokenHash).run();
}

export async function deleteSession(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM web_sessions WHERE token_hash=?").bind(tokenHash).run();
}


async function ensureDashboardSessionTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
}

export async function dashboardSessionStorageReady(env: Env): Promise<boolean> {
  try {
    await ensureDashboardSessionTable(env);
    await env.DB.prepare("SELECT token_hash FROM dashboard_sessions LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

export async function createDashboardSession(
  env: Env,
  tokenHash: string,
  expiresAt: number
): Promise<void> {
  await ensureDashboardSessionTable(env);
  await env.DB.prepare(
    "INSERT INTO dashboard_sessions(token_hash,expires_at,created_at) VALUES (?,?,?)"
  ).bind(tokenHash, expiresAt, Date.now()).run();
}

export async function getDashboardSession(
  env: Env,
  tokenHash: string
): Promise<DashboardSession | null> {
  await ensureDashboardSessionTable(env);
  return await env.DB.prepare(
    "SELECT token_hash,expires_at,created_at FROM dashboard_sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, Date.now()).first<DashboardSession>() ?? null;
}

export async function deleteDashboardSession(env: Env, tokenHash: string): Promise<void> {
  await ensureDashboardSessionTable(env);
  await env.DB.prepare("DELETE FROM dashboard_sessions WHERE token_hash=?").bind(tokenHash).run();
}

export async function getGuildSettings(env: Env, guildId: string): Promise<GuildSettings> {
  const row = await env.DB.prepare("SELECT config FROM guild_settings WHERE guild_id=?")
    .bind(guildId).first<{config:string}>();
  if (!row) return { ...DEFAULT_SETTINGS };
  let parsed: Partial<GuildSettings> = {};
  try { parsed = JSON.parse(row.config) as Partial<GuildSettings>; } catch {}
  return { ...DEFAULT_SETTINGS, ...parsed };
}

export async function saveGuildSettings(
  env: Env,
  guildId: string,
  patch: Partial<GuildSettings>
): Promise<GuildSettings> {
  const next = { ...(await getGuildSettings(env, guildId)), ...patch };
  await env.DB.prepare(`
    INSERT INTO guild_settings(guild_id, config, updated_at) VALUES (?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at
  `).bind(guildId, JSON.stringify(next), Date.now()).run();
  return next;
}

export async function listAllGuildSettings(env: Env, limit=20): Promise<Array<{guild_id:string;config:string}>> {
  const result = await env.DB.prepare(
    "SELECT guild_id, config FROM guild_settings ORDER BY updated_at DESC LIMIT ?"
  ).bind(limit).all<{guild_id:string;config:string}>();
  return result.results;
}

async function ensureBotGuildCacheTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_guild_cache (
      guild_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      seen_at INTEGER NOT NULL
    )
  `).run();
}

export type CachedBotGuild = {
  id: string;
  name: string;
  icon: string | null;
  seenAt: number;
};

export async function replaceBotGuildCache(
  env: Env,
  guilds: Array<{ id: string; name: string; icon: string | null }>
): Promise<void> {
  await ensureBotGuildCacheTable(env);
  const seenAt = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bot_guild_cache"),
    ...guilds.map(guild =>
      env.DB.prepare(
        "INSERT INTO bot_guild_cache(guild_id,name,icon,seen_at) VALUES (?,?,?,?)"
      ).bind(guild.id, guild.name, guild.icon, seenAt)
    )
  ]);
}

export async function listBotGuildCache(
  env: Env,
  maxAgeMs = 6 * 60 * 60_000
): Promise<CachedBotGuild[]> {
  await ensureBotGuildCacheTable(env);
  const result = await env.DB.prepare(`
    SELECT guild_id AS id, name, icon, seen_at AS seenAt
    FROM bot_guild_cache
    WHERE seen_at >= ?
    ORDER BY name COLLATE NOCASE, guild_id
  `).bind(Date.now() - Math.max(1, maxAgeMs)).all<CachedBotGuild>();
  return result.results;
}

export async function upsertBotGuildCache(
  env: Env,
  guild: { id:string; name:string; icon:string|null }
): Promise<void> {
  await ensureBotGuildCacheTable(env);
  await env.DB.prepare(`
    INSERT INTO bot_guild_cache(guild_id,name,icon,seen_at) VALUES (?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      name=excluded.name,
      icon=excluded.icon,
      seen_at=excluded.seen_at
  `).bind(guild.id,guild.name,guild.icon,Date.now()).run();
}

export async function deleteBotGuildCache(
  env: Env,
  guildId: string
): Promise<void> {
  await ensureBotGuildCacheTable(env);
  await env.DB.prepare("DELETE FROM bot_guild_cache WHERE guild_id=?")
    .bind(guildId).run();
}

async function ensureBotGuildMembershipTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_guild_membership (
      guild_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    )
  `).run();
}

export async function rememberBotGuildMembership(
  env: Env,
  guildId: string
): Promise<void> {
  if (!/^\d+$/.test(guildId)) return;
  await ensureBotGuildMembershipTable(env);
  await env.DB.prepare(`
    INSERT INTO bot_guild_membership(guild_id,seen_at) VALUES (?,?)
    ON CONFLICT(guild_id) DO UPDATE SET seen_at=excluded.seen_at
  `).bind(guildId,Date.now()).run();
}

export async function forgetBotGuildMembership(
  env: Env,
  guildId: string
): Promise<void> {
  await ensureBotGuildMembershipTable(env);
  await env.DB.prepare("DELETE FROM bot_guild_membership WHERE guild_id=?")
    .bind(guildId).run();
}

export async function replaceBotGuildMembership(
  env: Env,
  guildIds: string[]
): Promise<void> {
  await ensureBotGuildMembershipTable(env);
  const seenAt=Date.now();
  const unique=[...new Set(guildIds.filter(id=>/^\d+$/.test(id)))];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bot_guild_membership"),
    ...unique.map(id=>
      env.DB.prepare(
        "INSERT INTO bot_guild_membership(guild_id,seen_at) VALUES (?,?)"
      ).bind(id,seenAt)
    )
  ]);
}

export async function listKnownGuildIds(env: Env): Promise<string[]> {
  const queries = [
    "SELECT guild_id AS id FROM bot_guild_membership",
    "SELECT guild_id AS id FROM bot_guild_cache",
    "SELECT guild_id AS id FROM guild_settings",
    "SELECT guild_id AS id FROM products",
    "SELECT guild_id AS id FROM payments",
    "SELECT source_guild_id AS id FROM guild_backups",
    "SELECT target_guild_id AS id FROM guild_restore_jobs",
    "SELECT guild_id AS id FROM member_recovery_tokens",
    "SELECT guild_id AS id FROM panel_deployments",
    "SELECT guild_id AS id FROM vending_machines",
    "SELECT guild_id AS id FROM vending_stock_notifications",
    "SELECT guild_id AS id FROM vending_orders",
    "SELECT guild_id AS id FROM vending_achievement_rooms",
    "SELECT guild_id AS id FROM vending_achievement_routes",
    "SELECT guild_id AS id FROM member_activity_settings",
    "SELECT guild_id AS id FROM member_activity_members"
  ];

  const ids = new Set<string>();
  for (const sql of queries) {
    try {
      const result = await env.DB.prepare(sql + " LIMIT 250").all<{ id:string }>();
      for (const row of result.results ?? []) {
        const id = String(row.id ?? "");
        if (/^\d+$/.test(id)) ids.add(id);
      }
    } catch {
      // Optional feature tables are created lazily. Missing tables simply mean
      // there is no guild evidence from that subsystem yet.
    }
  }
  return [...ids];
}

export async function listProducts(env: Env, guildId: string): Promise<ProductRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE guild_id=? AND active=1 ORDER BY created_at DESC"
  ).bind(guildId).all<ProductRow>();
  return result.results;
}

export async function getProduct(env: Env, id: string): Promise<ProductRow | null> {
  return await env.DB.prepare("SELECT * FROM products WHERE id=?")
    .bind(id).first<ProductRow>() ?? null;
}

export async function createProduct(env: Env, row: ProductRow): Promise<ProductRow> {
  await env.DB.prepare(`
    INSERT INTO products(
      id,guild_id,name,description,price_yen,active,delivery_type,role_id,delivery_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id,row.guild_id,row.name,row.description,row.price_yen,row.active,
    row.delivery_type,row.role_id,row.delivery_text,row.created_at
  ).run();
  return row;
}

export async function deleteProduct(env: Env, guildId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE products SET active=0 WHERE guild_id=? AND id=? AND active=1"
  ).bind(guildId,id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function createPayment(env: Env, row: PaymentRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO payments(
      id,merchant_payment_id,guild_id,user_id,product_id,status,paypay_url,
      amount_yen,created_at,updated_at,delivered_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id,row.merchant_payment_id,row.guild_id,row.user_id,row.product_id,row.status,
    row.paypay_url,row.amount_yen,row.created_at,row.updated_at,row.delivered_at
  ).run();
}

export async function getPaymentByMerchantId(env: Env, merchantId: string): Promise<PaymentRow | null> {
  return await env.DB.prepare("SELECT * FROM payments WHERE merchant_payment_id=?")
    .bind(merchantId).first<PaymentRow>() ?? null;
}

export async function listPendingPayments(env: Env, limit=10): Promise<PaymentRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM payments
    WHERE delivered_at IS NULL
      AND created_at > ?
      AND status NOT IN ('CANCELED','EXPIRED','FAILED')
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(Date.now()-24*60*60_000,limit).all<PaymentRow>();
  return result.results;
}

export async function setPaymentStatus(env: Env, id:string, status:string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET status=?, updated_at=? WHERE id=?")
    .bind(status,Date.now(),id).run();
}

export async function markDelivered(env: Env, id:string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET delivered_at=?, updated_at=? WHERE id=?")
    .bind(Date.now(),Date.now(),id).run();
}

export async function putChallenge(
  env:Env,id:string,guildId:string,userId:string,code:string
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO verification_challenges(id,guild_id,user_id,code,expires_at)
    VALUES (?,?,?,?,?)
  `).bind(id,guildId,userId,code,Date.now()+5*60_000).run();
}

export async function getChallenge(env:Env,id:string): Promise<{
  guild_id:string;user_id:string;code:string;expires_at:number
}|null> {
  return env.DB.prepare(
    "SELECT guild_id,user_id,code,expires_at FROM verification_challenges WHERE id=?"
  ).bind(id).first<{guild_id:string;user_id:string;code:string;expires_at:number}>();
}

export async function deleteChallenge(env:Env,id:string): Promise<void> {
  await env.DB.prepare("DELETE FROM verification_challenges WHERE id=?").bind(id).run();
}

export async function getAuditCursor(env:Env,guildId:string): Promise<string|null> {
  const row=await env.DB.prepare("SELECT last_entry_id FROM audit_cursors WHERE guild_id=?")
    .bind(guildId).first<{last_entry_id:string|null}>();
  return row?.last_entry_id ?? null;
}

export async function setAuditCursor(env:Env,guildId:string,lastEntryId:string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_cursors(guild_id,last_entry_id,updated_at) VALUES (?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      last_entry_id=excluded.last_entry_id,
      updated_at=excluded.updated_at
  `).bind(guildId,lastEntryId,Date.now()).run();
}

// ── Amazon自販機 (CC-server) ──────────────────────────────────────────────────
// amazon-vending.ts が使う DB 関数。CC-server の実装をそのまま移植。

export type GuildConfig = Record<string, unknown> & { guild_id: string };

export async function getGuildConfig(env: Env, guildId: string): Promise<GuildConfig> {
  const row = await env.DB.prepare("SELECT * FROM guild_config WHERE guild_id=?").bind(guildId).first<GuildConfig>();
  if (row) return row;
  await env.DB.prepare("INSERT INTO guild_config(guild_id) VALUES(?)").bind(guildId).run();
  return (await env.DB.prepare("SELECT * FROM guild_config WHERE guild_id=?").bind(guildId).first<GuildConfig>())!;
}

export type AvConfig = { guild_id: string; panel_title: string; panel_description: string | null; ltc_address: string | null; api_type: string; api_key: string | null; review_channel_id: string | null };

// 既存の amazon_vending_config に実績投稿チャンネル列を追加する (CREATE TABLE IF NOT EXISTS では列が増えないため)
async function migrateAmazonVendingSchema(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("PRAGMA table_info(amazon_vending_config)").all<{ name: string }>();
  const columns = new Set((results ?? []).map(row => String(row.name)));
  if (!columns.has("review_channel_id")) {
    await env.DB.prepare("ALTER TABLE amazon_vending_config ADD COLUMN review_channel_id TEXT").run();
  }
}

export async function getAvConfig(env: Env, guildId: string): Promise<AvConfig> {
  const row = await env.DB.prepare("SELECT * FROM amazon_vending_config WHERE guild_id=?").bind(guildId).first<AvConfig>();
  return row ?? {
    guild_id: guildId,
    panel_title: "Amazon自販機",
    panel_description: "Amazon商品をLTCで購入できます。",
    ltc_address: null,
    api_type: "rainforest",
    api_key: null,
    review_channel_id: null,
  };
}

export async function upsertAvConfig(env: Env, cfg: AvConfig): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO amazon_vending_config(guild_id,panel_title,panel_description,ltc_address,api_type,api_key,review_channel_id)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      panel_title=excluded.panel_title,
      panel_description=excluded.panel_description,
      ltc_address=excluded.ltc_address,
      api_type=excluded.api_type,
      api_key=excluded.api_key,
      review_channel_id=excluded.review_channel_id
  `).bind(cfg.guild_id, cfg.panel_title, cfg.panel_description, cfg.ltc_address, cfg.api_type, cfg.api_key, cfg.review_channel_id).run();
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

// ── Amazon自販機: 注文と実績投稿 ──────────────────────────────────────────────

export type AvOrder = {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string | null;
  product_title: string;
  price_jpy: number;
  image_url: string | null;
  review_posted_at: number | null;
  review_message_id: string | null;
  created_at: number;
};

export async function createAvOrder(env: Env, order: Omit<AvOrder, "review_posted_at" | "review_message_id">): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO amazon_vending_orders(id,guild_id,user_id,channel_id,product_title,price_jpy,image_url,created_at) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(order.id, order.guild_id, order.user_id, order.channel_id, order.product_title, order.price_jpy, order.image_url, order.created_at).run();
}

export async function setAvOrderChannel(env: Env, id: string, channelId: string): Promise<void> {
  await env.DB.prepare("UPDATE amazon_vending_orders SET channel_id=? WHERE id=?").bind(channelId, id).run();
}

export async function getAvOrder(env: Env, id: string): Promise<AvOrder | null> {
  return env.DB.prepare("SELECT * FROM amazon_vending_orders WHERE id=?").bind(id).first<AvOrder>();
}

/** 実績投稿の二重送信を防ぐため、未投稿の注文だけを投稿中として確保する。確保できたら true。 */
export async function claimAvOrderReview(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE amazon_vending_orders SET review_posted_at=? WHERE id=? AND review_posted_at IS NULL"
  ).bind(Date.now(), id).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function completeAvOrderReview(env: Env, id: string, messageId: string): Promise<void> {
  await env.DB.prepare("UPDATE amazon_vending_orders SET review_message_id=? WHERE id=?").bind(messageId, id).run();
}

export async function releaseAvOrderReview(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE amazon_vending_orders SET review_posted_at=NULL WHERE id=? AND review_message_id IS NULL").bind(id).run();
}
