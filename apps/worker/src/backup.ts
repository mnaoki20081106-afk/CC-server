import type { Env } from "./types";
import { botJson, DiscordApiError, type DiscordPermissionOverwrite } from "./discord";
import { HttpError } from "./utils";
import {
  createBackupRecord, listBackupRecords, getBackupRecord, deleteBackupRecord,
  createRestoreJob, getRestoreJob, listRestoreJobsForGuild, updateRestoreJob, cancelRestoreJob,
  type BackupRow, type RestoreJobRow,
} from "./backup-db";

// ── snapshot shape ───────────────────────────────────────────────────────────
// Ported from xaccount-bot's apps/worker/src/backup.ts, trimmed to what cc-server
// can actually act on. Dropped, with reasons:
//  - OAuth-based "member recovery" (re-inviting members who left, via consent
//    tokens collected ahead of time): cc-server's dashboard has no per-user
//    Discord OAuth login at all (just a shared DASHBOARD_PASSWORD) — there is
//    no mechanism to ever collect that consent in the first place.
//  - Panel discovery/restoration (verification/ticket/product/vending panels):
//    cc-server has no verification system, no ticket system, and no generic
//    product/vending system (Amazon自販機 is LTC-specific and explicitly out
//    of scope for this port) — there is nothing to discover or restore here.
//  - "Bot settings"/vending/legacy-products restore: vending/shiire is
//    explicitly excluded this session. cc-server's own guild_config is
//    captured/restored instead, as the closest analog.
//  - Resumable cross-request restore jobs with a persisted cursor: xaccount-bot
//    batches role/channel edits across many HTTP requests so a very large
//    guild (thousands of roles/channels/members) never exceeds one Worker
//    invocation's time budget. cc-server runs the whole restore in one
//    ctx.waitUntil() background task instead — simpler, and sufficient for
//    the guild sizes cc-server actually manages — at the cost of not being
//    safe for an extremely large guild. The job/progress row is still kept
//    (for the dashboard's polling UI) but the batching/cursor machinery that
//    exists purely to survive request-level timeouts is not.

type SnapshotRole = {
  id: string; name: string; color: number; hoist: boolean; position: number;
  permissions: string; managed: boolean; mentionable: boolean;
};

type SnapshotChannel = {
  id: string; name: string; type: number; position: number;
  parent_id: string | null; topic: string | null;
  permission_overwrites: DiscordPermissionOverwrite[];
};

type SnapshotMember = {
  user_id: string; username: string; nick: string | null; roles: string[];
  communication_disabled_until: string | null;
};

type SnapshotBan = { user_id: string; username: string; reason: string | null };

type GuildSnapshot = {
  version: 1;
  createdAt: number;
  sourceGuild: {
    id: string; name: string;
    verification_level?: number; default_message_notifications?: number;
    explicit_content_filter?: number; afk_timeout?: number; afk_channel_id?: string | null;
    system_channel_id?: string | null; rules_channel_id?: string | null;
  };
  roles: SnapshotRole[];
  channels: SnapshotChannel[];
  members: SnapshotMember[];
  bans: SnapshotBan[];
  welcomeScreen: Record<string, unknown> | null;
  guildConfig: Record<string, unknown>;
  capture: { membersComplete: boolean; bansComplete: boolean; warnings: string[] };
};

export type RestoreStats = {
  rolesCreated: number; rolesUpdated: number;
  channelsCreated: number; channelsUpdated: number;
  membersUpdated: number; membersNotPresent: number;
  bansRestored: number; guildExtrasRestored: boolean;
  warnings: string[];
};

const EMPTY_STATS: RestoreStats = {
  rolesCreated: 0, rolesUpdated: 0, channelsCreated: 0, channelsUpdated: 0,
  membersUpdated: 0, membersNotPresent: 0, bansRestored: 0, guildExtrasRestored: false, warnings: [],
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

// ── capture ───────────────────────────────────────────────────────────────────

async function captureMembers(env: Env, guildId: string, warnings: string[]): Promise<{ members: SnapshotMember[]; complete: boolean }> {
  const members: SnapshotMember[] = [];
  let after = "";
  let complete = true;
  for (let page = 0; page < 100; page++) {
    const path = `/guilds/${guildId}/members?limit=1000${after ? `&after=${after}` : ""}`;
    let chunk: any[];
    try {
      chunk = await botJson<any[]>(env, path);
    } catch (err) {
      complete = false;
      warnings.push(
        err instanceof DiscordApiError && err.status === 403
          ? "メンバー一覧を取得できませんでした。Discord Developer PortalでServer Members Intentを有効にしてください。"
          : "メンバー一覧の取得が途中で失敗しました。取得済み分のみ保存しました。"
      );
      break;
    }
    for (const item of chunk) {
      if (item.user?.bot || !item.user?.id) continue;
      members.push({
        user_id: String(item.user.id),
        username: String(item.user.global_name || item.user.username || item.user.id),
        nick: item.nick ?? null,
        roles: Array.isArray(item.roles) ? item.roles.map(String) : [],
        communication_disabled_until: item.communication_disabled_until ?? null,
      });
    }
    if (chunk.length < 1000) break;
    after = String(chunk[chunk.length - 1]?.user?.id ?? "");
    if (!after) { complete = false; break; }
  }
  return { members, complete };
}

async function captureBans(env: Env, guildId: string, warnings: string[]): Promise<{ bans: SnapshotBan[]; complete: boolean }> {
  const bans: SnapshotBan[] = [];
  let after = "";
  let complete = true;
  for (let page = 0; page < 100; page++) {
    const path = `/guilds/${guildId}/bans?limit=1000${after ? `&after=${after}` : ""}`;
    let chunk: any[];
    try {
      chunk = await botJson<any[]>(env, path);
    } catch (err) {
      complete = false;
      warnings.push(
        err instanceof DiscordApiError && err.status === 403
          ? "BAN一覧を取得できませんでした。BOTに「メンバーをBAN」権限が必要です。"
          : "BAN一覧の取得が途中で失敗しました。取得済み分のみ保存しました。"
      );
      break;
    }
    for (const item of chunk) {
      if (!item.user?.id) continue;
      bans.push({ user_id: String(item.user.id), username: String(item.user.global_name || item.user.username || item.user.id), reason: item.reason ?? null });
    }
    if (chunk.length < 1000) break;
    after = String(chunk[chunk.length - 1]?.user?.id ?? "");
    if (!after) { complete = false; break; }
  }
  return { bans, complete };
}

export async function createBackup(env: Env, guildId: string, label: string | null, guildConfig: Record<string, unknown>): Promise<ReturnType<typeof publicBackup>> {
  const warnings: string[] = [];
  const guild = await botJson<any>(env, `/guilds/${guildId}`);
  const [rolesRaw, channelsRaw] = await Promise.all([
    botJson<any[]>(env, `/guilds/${guildId}/roles`),
    botJson<any[]>(env, `/guilds/${guildId}/channels`),
  ]);

  const roles: SnapshotRole[] = rolesRaw.map(r => ({
    id: String(r.id), name: String(r.name), color: Number(r.color ?? 0), hoist: Boolean(r.hoist),
    position: Number(r.position ?? 0), permissions: String(r.permissions ?? "0"),
    managed: Boolean(r.managed), mentionable: Boolean(r.mentionable),
  }));

  const channels: SnapshotChannel[] = channelsRaw.map(c => ({
    id: String(c.id), name: String(c.name), type: Number(c.type), position: Number(c.position ?? 0),
    parent_id: c.parent_id ?? null, topic: c.topic ?? null,
    permission_overwrites: Array.isArray(c.permission_overwrites)
      ? c.permission_overwrites.map((o: any) => ({ id: String(o.id), type: Number(o.type), allow: String(o.allow ?? "0"), deny: String(o.deny ?? "0") }))
      : [],
  }));

  const [memberCapture, banCapture, welcomeScreen] = await Promise.all([
    captureMembers(env, guildId, warnings),
    captureBans(env, guildId, warnings),
    botJson<Record<string, unknown>>(env, `/guilds/${guildId}/welcome-screen`).catch(() => {
      warnings.push("Welcome Screenを取得できませんでした。");
      return null;
    }),
  ]);

  const snapshot: GuildSnapshot = {
    version: 1,
    createdAt: Date.now(),
    sourceGuild: {
      id: String(guild.id), name: String(guild.name),
      verification_level: guild.verification_level, default_message_notifications: guild.default_message_notifications,
      explicit_content_filter: guild.explicit_content_filter, afk_timeout: guild.afk_timeout,
      afk_channel_id: guild.afk_channel_id ?? null, system_channel_id: guild.system_channel_id ?? null,
      rules_channel_id: guild.rules_channel_id ?? null,
    },
    roles, channels, members: memberCapture.members, bans: banCapture.bans,
    welcomeScreen, guildConfig,
    capture: { membersComplete: memberCapture.complete, bansComplete: banCapture.complete, warnings },
  };

  const payload = JSON.stringify(snapshot);
  const row = await createBackupRecord(env, {
    sourceGuildId: guildId, sourceGuildName: String(guild.name), label: label?.trim().slice(0, 80) || null,
    payload, roleCount: roles.length, channelCount: channels.length, memberCount: memberCapture.members.length,
    warnings,
  });
  return publicBackup(row);
}

function publicBackup(row: BackupRow) {
  return {
    id: row.id, sourceGuildId: row.source_guild_id, sourceGuildName: row.source_guild_name,
    label: row.label, createdAt: row.created_at, roleCount: row.role_count,
    channelCount: row.channel_count, memberCount: row.member_count,
    warnings: parseJson<string[]>(row.warnings_json, []),
  };
}

export async function listBackups(env: Env) {
  return (await listBackupRecords(env)).map(publicBackup);
}

export async function deleteBackup(env: Env, id: string): Promise<void> {
  await deleteBackupRecord(env, id);
}

async function loadSnapshot(env: Env, backupId: string): Promise<{ row: BackupRow; snapshot: GuildSnapshot }> {
  const row = await getBackupRecord(env, backupId);
  if (!row) throw new HttpError(404, "バックアップが見つかりません");
  return { row, snapshot: JSON.parse(row.payload) as GuildSnapshot };
}

// ── restore preview (dry-run diff) ────────────────────────────────────────────

export async function previewRestore(env: Env, backupId: string, targetGuildId: string) {
  const { row, snapshot } = await loadSnapshot(env, backupId);
  const [targetRoles, targetChannels] = await Promise.all([
    botJson<any[]>(env, `/guilds/${targetGuildId}/roles`),
    botJson<any[]>(env, `/guilds/${targetGuildId}/channels`),
  ]);
  const targetRoleNames = new Set(targetRoles.map((r: any) => String(r.name)));
  const targetChannelNames = new Set(targetChannels.map((c: any) => `${c.type}:${c.name}`));
  const missingRoles = snapshot.roles.filter(r => !r.managed && r.id !== snapshot.sourceGuild.id && !targetRoleNames.has(r.name)).length;
  const missingChannels = snapshot.channels.filter(c => !targetChannelNames.has(`${c.type}:${c.name}`)).length;

  return {
    source: { id: snapshot.sourceGuild.id, name: snapshot.sourceGuild.name },
    target: { id: targetGuildId, name: String((await botJson<any>(env, `/guilds/${targetGuildId}`)).name) },
    counts: {
      roles: snapshot.roles.length, missingRoles,
      channels: snapshot.channels.length, missingChannels,
      members: snapshot.members.length, bans: snapshot.bans.length,
    },
    behavior: {
      destructive: false,
      reusesMatching: true,
      memberRestoreLimitedToPresentMembers: true,
    },
    warnings: [
      ...snapshot.capture.warnings,
      "退出済みメンバーの再招待はサポートしていません。現在サーバーに残っているメンバーのロール・ニックネーム・タイムアウトのみ復元します。",
      ...(row.id ? [] : []),
    ],
  };
}

// ── restore execution ─────────────────────────────────────────────────────────

export async function startRestore(env: Env, backupId: string, targetGuildId: string, ctx: ExecutionContext): Promise<RestoreJobRow> {
  const { snapshot } = await loadSnapshot(env, backupId); // validates the backup exists
  void snapshot;
  const job = await createRestoreJob(env, backupId, targetGuildId);
  ctx.waitUntil(runRestore(env, job.id).catch(err => {
    console.error("restore job failed", err);
    void updateRestoreJob(env, job.id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  }));
  return job;
}

export async function listRestoreJobs(env: Env, targetGuildId: string) {
  return listRestoreJobsForGuild(env, targetGuildId);
}

export async function cancelRestore(env: Env, jobId: string): Promise<boolean> {
  return cancelRestoreJob(env, jobId);
}

export async function getRestoreJobPublic(env: Env, id: string) {
  const row = await getRestoreJob(env, id);
  if (!row) throw new HttpError(404, "リストアジョブが見つかりません");
  return row;
}

// Restore has no way to abort an in-flight Discord API call, so cancellation
// is checked between phases and takes effect at the next boundary.
async function isCancelled(env: Env, jobId: string): Promise<boolean> {
  const current = await getRestoreJob(env, jobId);
  return current?.status === "cancelled";
}

async function runRestore(env: Env, jobId: string): Promise<void> {
  const job = await getRestoreJob(env, jobId);
  if (!job) return;
  const { snapshot } = await loadSnapshot(env, job.backup_id);
  const stats: RestoreStats = { ...EMPTY_STATS, warnings: [] };
  const roleMap: Record<string, string> = {};
  const channelMap: Record<string, string> = {};

  // roles (skip @everyone and managed/integration roles — those can't be created)
  const editableRoles = snapshot.roles.filter(r => !r.managed && r.id !== snapshot.sourceGuild.id).sort((a, b) => a.position - b.position);
  const targetRoles = await botJson<any[]>(env, `/guilds/${job.target_guild_id}/roles`);
  for (const source of editableRoles) {
    let target = targetRoles.find((r: any) => !r.managed && String(r.name) === source.name && !Object.values(roleMap).includes(String(r.id)));
    const body = { name: source.name, permissions: source.permissions, color: source.color, hoist: source.hoist, mentionable: source.mentionable };
    if (!target) {
      target = await botJson<any>(env, `/guilds/${job.target_guild_id}/roles`, { method: "POST", body: JSON.stringify(body) });
      targetRoles.push(target);
      stats.rolesCreated++;
    } else {
      await botJson(env, `/guilds/${job.target_guild_id}/roles/${target.id}`, { method: "PATCH", body: JSON.stringify(body) });
      stats.rolesUpdated++;
    }
    roleMap[source.id] = String(target.id);
  }
  roleMap[snapshot.sourceGuild.id] = job.target_guild_id;

  if (await isCancelled(env, jobId)) { await updateRestoreJob(env, jobId, { result_json: JSON.stringify(stats) }); return; }

  // channels (categories first, so parent_id can be remapped)
  const targetChannels = await botJson<any[]>(env, `/guilds/${job.target_guild_id}/channels`);
  const orderedChannels = [...snapshot.channels].sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || a.position - b.position);
  for (const source of orderedChannels) {
    const mappedParent = source.parent_id ? channelMap[source.parent_id] ?? null : null;
    let target = targetChannels.find((c: any) =>
      !Object.values(channelMap).includes(String(c.id)) && Number(c.type) === source.type && String(c.name) === source.name
    );
    const overwrites = source.permission_overwrites
      .map(o => {
        const id = o.type === 0 ? (o.id === snapshot.sourceGuild.id ? job.target_guild_id : roleMap[o.id]) : o.id;
        return id ? { ...o, id } : null;
      })
      .filter((o): o is DiscordPermissionOverwrite => o !== null);
    const payload: Record<string, unknown> = { name: source.name, topic: source.topic, permission_overwrites: overwrites };
    if (source.type !== 4) payload.parent_id = mappedParent;
    if (!target) {
      target = await botJson<any>(env, `/guilds/${job.target_guild_id}/channels`, { method: "POST", body: JSON.stringify({ ...payload, type: source.type }) });
      targetChannels.push(target);
      stats.channelsCreated++;
    } else {
      await botJson(env, `/channels/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      stats.channelsUpdated++;
    }
    channelMap[source.id] = String(target.id);
  }

  if (await isCancelled(env, jobId)) { await updateRestoreJob(env, jobId, { result_json: JSON.stringify(stats) }); return; }

  // positions (best-effort, ignore failures)
  try {
    const positions = orderedChannels.filter(c => channelMap[c.id]).map(c => ({ id: channelMap[c.id], position: c.position }));
    if (positions.length) await botJson(env, `/guilds/${job.target_guild_id}/channels`, { method: "PATCH", body: JSON.stringify(positions) });
  } catch {
    stats.warnings.push("チャンネルの並び順を復元できませんでした。");
  }

  // guild extras (verification level etc.) — best-effort
  try {
    await botJson(env, `/guilds/${job.target_guild_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        verification_level: snapshot.sourceGuild.verification_level,
        default_message_notifications: snapshot.sourceGuild.default_message_notifications,
        explicit_content_filter: snapshot.sourceGuild.explicit_content_filter,
      }),
    });
    stats.guildExtrasRestored = true;
  } catch {
    stats.warnings.push("サーバー全体の設定（認証レベル等）を復元できませんでした。");
  }

  if (await isCancelled(env, jobId)) { await updateRestoreJob(env, jobId, { result_json: JSON.stringify(stats) }); return; }

  // bans
  for (const ban of snapshot.bans) {
    try {
      await botJson(env, `/guilds/${job.target_guild_id}/bans/${ban.user_id}`, {
        method: "PUT",
        body: JSON.stringify({ reason: ban.reason ?? undefined }),
      });
      stats.bansRestored++;
    } catch {
      stats.warnings.push(`BAN復元に失敗したユーザーがいます: ${ban.username}`);
    }
  }

  if (await isCancelled(env, jobId)) { await updateRestoreJob(env, jobId, { result_json: JSON.stringify(stats) }); return; }

  // members currently present: restore roles / nickname / timeout
  for (const member of snapshot.members) {
    const mappedRoles = member.roles.map(id => roleMap[id]).filter((id): id is string => Boolean(id));
    try {
      await botJson(env, `/guilds/${job.target_guild_id}/members/${member.user_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          roles: mappedRoles,
          nick: member.nick,
          communication_disabled_until: member.communication_disabled_until,
        }),
      });
      stats.membersUpdated++;
    } catch (err) {
      if (err instanceof DiscordApiError && err.status === 404) stats.membersNotPresent++;
      else stats.warnings.push(`メンバーの復元に失敗しました: ${member.username}`);
    }
  }

  if (await isCancelled(env, jobId)) { await updateRestoreJob(env, jobId, { result_json: JSON.stringify(stats) }); return; }
  await updateRestoreJob(env, jobId, { status: "completed", result_json: JSON.stringify(stats) });
}
