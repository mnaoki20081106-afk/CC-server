// Ported from xaccount-bot's apps/worker/src/security/db.ts.
// Dropped tables (no analog in cc-server's single-bot architecture):
// - bridge_nonces: only needed for the legacy cross-worker HMAC bridge
//   replay protection. cc-server calls the security service in-process.
// - maintenance_leases: existed so a separate "Main Bot" could register a
//   lease before editing channels/roles, so the security engine wouldn't
//   treat its own dashboard's edits as an attack. cc-server's dashboard
//   edits channels/roles with the SAME bot token the security engine
//   trusts by identity (engine.ts's trusted() already exempts
//   actorId === env.DISCORD_APPLICATION_ID), so no lease is needed.
// - managed_service_bots: a registry of *other* trusted bots in a
//   multi-bot deployment. SecuritySettings.allowedBotIds already covers
//   "trust this other bot" for cc-server's single-bot case.
import type { Env } from "../types";
import type { SecurityIncident, SecuritySettings } from "./types";

export const SECURITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS security_settings (
    guild_id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS security_incidents (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    actor_id TEXT,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS security_incidents_guild_idx ON security_incidents(guild_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS lockdown_snapshots (
    guild_id TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS processed_audit_entries (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    processed_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS processed_audit_entries_time_idx ON processed_audit_entries(processed_at)`,

  `CREATE TABLE IF NOT EXISTS audit_cursors (
    guild_id TEXT PRIMARY KEY,
    last_entry_id TEXT,
    updated_at INTEGER NOT NULL
  )`,
];

export const DEFAULT_SETTINGS: SecuritySettings = {
  enabled: true,
  mode: "enforce",
  profile: "strict",
  modules: {
    antiNuke: true,
    antiRaid: true,
    antiSpam: true,
    antiPhishing: true,
    dangerousAttachments: true,
    botGuard: true,
    webhookGuard: true,
    roleGuard: true,
    permissionGuard: true,
    automodGuard: true,
    guildGuard: true,
    memberGuard: true,
  },
  thresholds: {
    actionWindowSeconds: 12,
    crossActionWindowSeconds: 30,
    crossActionScore: 12,
    channelDelete: 2,
    channelCreate: 6,
    channelUpdate: 5,
    channelOverwrite: 4,
    roleDelete: 2,
    roleCreate: 6,
    roleUpdate: 4,
    banAdd: 4,
    memberPrune: 10,
    kick: 5,
    webhook: 2,
    botAdd: 1,
    guildUpdate: 2,
    automodChange: 1,
    raidJoins: 8,
    raidWindowSeconds: 12,
    spamMessages: 6,
    spamWindowSeconds: 8,
    mentionLimit: 8,
    linkBurst: 3,
    linkWindowSeconds: 20,
    severeContentUsers: 3,
    severeContentWindowSeconds: 30,
    minAccountAgeHours: 24,
  },
  response: {
    stripDangerousRoles: true,
    kickMaliciousBots: true,
    timeoutMinutes: 30,
    autoLockdown: true,
    lockdownMinutes: 15,
    deleteUnsafeMessages: true,
    quarantineRaidJoins: true,
  },
  safety: {
    enforceExplicitContentFilter: true,
    minimumVerificationLevel: 2,
  },
  logChannelId: null,
  trustedUserIds: [],
  trustedRoleIds: [],
  allowedBotIds: [],
  allowedDomains: ["discord.com", "discord.gg", "discordapp.com"],
  blockedDomains: [],
};

function mergeSettings(input: Partial<SecuritySettings> | null): SecuritySettings {
  const value = input ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    modules: { ...DEFAULT_SETTINGS.modules, ...(value.modules ?? {}) },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(value.thresholds ?? {}) },
    response: { ...DEFAULT_SETTINGS.response, ...(value.response ?? {}) },
    safety: { ...DEFAULT_SETTINGS.safety, ...(value.safety ?? {}) },
    trustedUserIds: Array.isArray(value.trustedUserIds) ? value.trustedUserIds : [],
    trustedRoleIds: Array.isArray(value.trustedRoleIds) ? value.trustedRoleIds : [],
    allowedBotIds: Array.isArray(value.allowedBotIds) ? value.allowedBotIds : [],
    allowedDomains: Array.isArray(value.allowedDomains) ? value.allowedDomains.map(x => x.toLowerCase()) : DEFAULT_SETTINGS.allowedDomains,
    blockedDomains: Array.isArray(value.blockedDomains) ? value.blockedDomains.map(x => x.toLowerCase()) : [],
  };
}

export async function getSecuritySettings(env: Env, guildId: string): Promise<SecuritySettings> {
  const row = await env.DB.prepare("SELECT config FROM security_settings WHERE guild_id=?").bind(guildId).first<{ config: string }>();
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return mergeSettings(JSON.parse(row.config) as Partial<SecuritySettings>);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSecuritySettings(env: Env, guildId: string, patch: Partial<SecuritySettings>): Promise<SecuritySettings> {
  const current = await getSecuritySettings(env, guildId);
  const next = mergeSettings({
    ...current,
    ...patch,
    modules: { ...current.modules, ...(patch.modules ?? {}) },
    thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) },
    response: { ...current.response, ...(patch.response ?? {}) },
    safety: { ...current.safety, ...(patch.safety ?? {}) },
  });
  await env.DB.prepare(`
    INSERT INTO security_settings(guild_id, config, updated_at) VALUES(?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at
  `).bind(guildId, JSON.stringify(next), Date.now()).run();
  return next;
}

export async function recordIncident(env: Env, input: Omit<SecurityIncident, "id" | "createdAt">): Promise<SecurityIncident> {
  const incident: SecurityIncident = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
  await env.DB.prepare(`
    INSERT INTO security_incidents(id,guild_id,actor_id,kind,severity,summary,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)
  `).bind(incident.id, incident.guildId, incident.actorId, incident.kind, incident.severity, incident.summary, JSON.stringify(incident.data), incident.createdAt).run();
  return incident;
}

export async function listIncidents(env: Env, guildId: string, limit = 30): Promise<SecurityIncident[]> {
  const rows = (await env.DB.prepare(`
    SELECT * FROM security_incidents WHERE guild_id=? ORDER BY created_at DESC LIMIT ?
  `).bind(guildId, Math.max(1, Math.min(100, limit))).all<{
    id: string; guild_id: string; actor_id: string | null; kind: string;
    severity: SecurityIncident["severity"]; summary: string; data_json: string; created_at: number;
  }>()).results;
  return rows.map(row => ({
    id: row.id,
    guildId: row.guild_id,
    actorId: row.actor_id,
    kind: row.kind,
    severity: row.severity,
    summary: row.summary,
    data: (() => {
      try { return JSON.parse(row.data_json) as Record<string, unknown>; } catch { return {}; }
    })(),
    createdAt: row.created_at,
  }));
}

// Dropped (see file header): maintenance leases always report "no lease",
// since engine.ts's trusted() already exempts the bot's own actions by
// identity, which is what leases existed to approximate for a *different*
// bot's edits.
export async function hasMaintenanceLease(): Promise<boolean> { return false; }
export async function hasGuildMaintenanceLease(): Promise<boolean> { return false; }

export async function cleanExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM processed_audit_entries WHERE processed_at<?").bind(now - 24 * 60 * 60_000),
  ]);
}

export async function claimAuditEntry(env: Env, guildId: string, entryId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_audit_entries(id,guild_id,processed_at) VALUES(?,?,?)"
  ).bind(entryId, guildId, Date.now()).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getAuditCursor(env: Env, guildId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT last_entry_id FROM audit_cursors WHERE guild_id=?").bind(guildId).first<{ last_entry_id: string | null }>();
  return row?.last_entry_id ?? null;
}

export async function advanceAuditCursor(env: Env, guildId: string, entryId: string): Promise<void> {
  const current = await getAuditCursor(env, guildId);
  let shouldAdvance = !current;
  if (current) {
    try {
      shouldAdvance = BigInt(entryId) > BigInt(current);
    } catch {
      shouldAdvance = entryId !== current;
    }
  }
  if (!shouldAdvance) return;
  await env.DB.prepare(`
    INSERT INTO audit_cursors(guild_id,last_entry_id,updated_at) VALUES(?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET last_entry_id=excluded.last_entry_id, updated_at=excluded.updated_at
  `).bind(guildId, entryId, Date.now()).run();
}

export type LockdownSnapshot = {
  guildId: string;
  reason: string;
  expiresAt: number;
  createdAt: number;
  channels: Array<{
    channelId: string;
    permissionOverwrites: Array<{ id: string; type: number; allow: string; deny: string }>;
  }>;
};

export async function putLockdownSnapshot(env: Env, snapshot: LockdownSnapshot): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO lockdown_snapshots(guild_id,snapshot_json,reason,expires_at,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, reason=excluded.reason, expires_at=excluded.expires_at, created_at=excluded.created_at
  `).bind(snapshot.guildId, JSON.stringify(snapshot.channels), snapshot.reason, snapshot.expiresAt, snapshot.createdAt).run();
}

export async function getLockdownSnapshot(env: Env, guildId: string): Promise<LockdownSnapshot | null> {
  const row = await env.DB.prepare("SELECT * FROM lockdown_snapshots WHERE guild_id=?").bind(guildId).first<{
    guild_id: string; snapshot_json: string; reason: string; expires_at: number; created_at: number;
  }>();
  if (!row) return null;
  return {
    guildId: row.guild_id,
    reason: row.reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    channels: JSON.parse(row.snapshot_json),
  } as LockdownSnapshot;
}

export async function deleteLockdownSnapshot(env: Env, guildId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM lockdown_snapshots WHERE guild_id=?").bind(guildId).run();
}

export async function listExpiredLockdowns(env: Env): Promise<string[]> {
  const rows = (await env.DB.prepare("SELECT guild_id FROM lockdown_snapshots WHERE expires_at<=? LIMIT 20").bind(Date.now()).all<{ guild_id: string }>()).results;
  return rows.map(row => row.guild_id);
}

// Dropped (see file header): managed-service-bot registry has no analog —
// SecuritySettings.allowedBotIds covers the same "trust this bot" need.
export async function isManagedServiceBot(): Promise<boolean> { return false; }
export async function listManagedServiceBots(): Promise<Array<{ botId: string; kind: string }>> { return []; }
