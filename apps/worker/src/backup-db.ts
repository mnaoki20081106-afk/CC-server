import type { Env } from "./types";

export const BACKUP_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS guild_backups (
    id TEXT PRIMARY KEY,
    source_guild_id TEXT NOT NULL,
    source_guild_name TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    role_count INTEGER NOT NULL DEFAULT 0,
    channel_count INTEGER NOT NULL DEFAULT 0,
    member_count INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS guild_backups_source_idx ON guild_backups(source_guild_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS guild_restore_jobs (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    target_guild_id TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS guild_restore_jobs_target_idx ON guild_restore_jobs(target_guild_id, created_at DESC)`,
];

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export type BackupRow = {
  id: string;
  source_guild_id: string;
  source_guild_name: string;
  label: string | null;
  created_at: number;
  payload: string;
  role_count: number;
  channel_count: number;
  member_count: number;
  warnings_json: string;
};

export async function createBackupRecord(env: Env, data: {
  sourceGuildId: string; sourceGuildName: string; label: string | null; payload: string;
  roleCount: number; channelCount: number; memberCount: number; warnings: string[];
}): Promise<BackupRow> {
  const id = randomId();
  const row: BackupRow = {
    id, source_guild_id: data.sourceGuildId, source_guild_name: data.sourceGuildName,
    label: data.label, created_at: Date.now(), payload: data.payload,
    role_count: data.roleCount, channel_count: data.channelCount, member_count: data.memberCount,
    warnings_json: JSON.stringify(data.warnings),
  };
  await env.DB.prepare(
    `INSERT INTO guild_backups(id,source_guild_id,source_guild_name,label,created_at,payload,role_count,channel_count,member_count,warnings_json)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.source_guild_id, row.source_guild_name, row.label, row.created_at, row.payload, row.role_count, row.channel_count, row.member_count, row.warnings_json).run();
  return row;
}

export async function listBackupRecords(env: Env): Promise<BackupRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id,source_guild_id,source_guild_name,label,created_at,role_count,channel_count,member_count,warnings_json FROM guild_backups ORDER BY created_at DESC LIMIT 100`
  ).all<Omit<BackupRow, "payload">>();
  return results.map(r => ({ ...r, payload: "" }));
}

export async function getBackupRecord(env: Env, id: string): Promise<BackupRow | null> {
  return env.DB.prepare(`SELECT * FROM guild_backups WHERE id=?`).bind(id).first<BackupRow>();
}

export async function deleteBackupRecord(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM guild_backups WHERE id=?`).bind(id).run();
}

export type RestoreJobRow = {
  id: string;
  backup_id: string;
  target_guild_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export async function createRestoreJob(env: Env, backupId: string, targetGuildId: string): Promise<RestoreJobRow> {
  const id = randomId();
  const now = Date.now();
  const row: RestoreJobRow = { id, backup_id: backupId, target_guild_id: targetGuildId, status: "running", result_json: "{}", error: null, created_at: now, updated_at: now };
  await env.DB.prepare(
    `INSERT INTO guild_restore_jobs(id,backup_id,target_guild_id,status,result_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.backup_id, row.target_guild_id, row.status, row.result_json, row.error, row.created_at, row.updated_at).run();
  return row;
}

export async function getRestoreJob(env: Env, id: string): Promise<RestoreJobRow | null> {
  return env.DB.prepare(`SELECT * FROM guild_restore_jobs WHERE id=?`).bind(id).first<RestoreJobRow>();
}

export async function listRestoreJobsForGuild(env: Env, targetGuildId: string): Promise<RestoreJobRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM guild_restore_jobs WHERE target_guild_id=? ORDER BY created_at DESC LIMIT 20`
  ).bind(targetGuildId).all<RestoreJobRow>();
  return results;
}

export async function updateRestoreJob(env: Env, id: string, patch: Partial<Pick<RestoreJobRow, "status" | "result_json" | "error">>): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = [...keys.map(k => `${k}=?`), "updated_at=?"].join(",");
  const vals = [...keys.map(k => (patch as any)[k]), Date.now()];
  await env.DB.prepare(`UPDATE guild_restore_jobs SET ${set} WHERE id=?`).bind(...vals, id).run();
}

// Marks a still-running job as cancelled. runRestore() polls this status
// between phases and stops early once it sees it — there is no way to abort
// an in-flight Discord API call, so cancellation takes effect at the next
// phase boundary (role/channel/position/extras/bans/members), not instantly.
export async function cancelRestoreJob(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE guild_restore_jobs SET status='cancelled', updated_at=? WHERE id=? AND status='running'`
  ).bind(Date.now(), id).run();
  return (result.meta.changes ?? 0) > 0;
}
