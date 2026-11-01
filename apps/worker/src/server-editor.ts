import type { Env } from "./types";
import { botFetch, botJson, DiscordApiError, type DiscordChannel, type DiscordRole } from "./discord";
import { HttpError } from "./utils";

// ── permission model ────────────────────────────────────────────────────────
// Ported from xaccount-bot's apps/worker/src/index.ts: a curated, UI-friendly
// subset of Discord's permission bits (not the raw ADMINISTRATOR-style bitmask)
// so the dashboard can present per-channel allow/deny/inherit toggles.

export type ChannelPermissionKey =
  "view" | "send" | "history" | "react" | "files" | "embeds" | "appCommands" | "polls" |
  "createPublicThreads" | "createPrivateThreads" | "sendInThreads" | "manageThreads" |
  "manageMessages" | "mentionEveryone" | "externalEmojis" | "externalStickers" |
  "voiceMessages" | "createInvite" | "manageWebhooks" | "pinMessages" | "bypassSlowmode" |
  "connect" | "speak" | "stream" | "useVad" | "soundboard" | "externalSounds" |
  "setVoiceStatus" | "prioritySpeaker" | "muteMembers" | "deafenMembers" | "moveMembers" |
  "threads";
export type ChannelPermissionMode = "inherit" | "allow" | "deny";
export type ChannelPermissionPatch = Partial<Record<ChannelPermissionKey, ChannelPermissionMode>>;

export const CHANNEL_PERMISSION_BITS: Record<ChannelPermissionKey, bigint> = {
  view: 1024n, send: 2048n, history: 65536n, react: 64n, files: 32768n, embeds: 16384n,
  appCommands: 2147483648n, polls: 562949953421312n,
  createPublicThreads: 34359738368n, createPrivateThreads: 68719476736n,
  sendInThreads: 274877906944n, manageThreads: 17179869184n,
  manageMessages: 8192n, mentionEveryone: 131072n, externalEmojis: 262144n, externalStickers: 137438953472n,
  voiceMessages: 70368744177664n, createInvite: 1n, manageWebhooks: 536870912n,
  pinMessages: 2251799813685248n, bypassSlowmode: 4503599627370496n,
  connect: 1048576n, speak: 2097152n, stream: 512n, useVad: 33554432n,
  soundboard: 4398046511104n, externalSounds: 35184372088832n, setVoiceStatus: 281474976710656n,
  prioritySpeaker: 256n, muteMembers: 4194304n, deafenMembers: 8388608n, moveMembers: 16777216n,
  threads: 34359738368n,
};

const PANEL_PERMISSION_MASK = 1024n | 2048n | 16384n;
// VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | READ_MESSAGE_HISTORY | ADD_REACTIONS | MANAGE_CHANNELS
const BOT_CHANNEL_GUARD_MASK = PANEL_PERMISSION_MASK | 32768n | 65536n | 8192n | 16n | 268435456n;

type DiscordGuildMember = { roles: string[]; user?: { id?: string; bot?: boolean } };

function fallbackBotMember(botId: string, roles: DiscordRole[]): DiscordGuildMember {
  return { roles: roles.filter(role => role.tags?.bot_id === botId).map(role => role.id) };
}

async function getBotGuildMember(env: Env, guildId: string, roles: DiscordRole[]): Promise<DiscordGuildMember> {
  const botId = env.DISCORD_APPLICATION_ID.trim();
  try {
    return await botJson<DiscordGuildMember>(env, `/guilds/${guildId}/members/${botId}`);
  } catch {
    return fallbackBotMember(botId, roles);
  }
}

function botBasePermissions(guildId: string, roles: DiscordRole[], member: DiscordGuildMember): bigint {
  let permissions = BigInt(roles.find(role => role.id === guildId)?.permissions ?? "0");
  for (const roleId of member.roles) {
    const role = roles.find(item => item.id === roleId);
    if (role) permissions |= BigInt(role.permissions || "0");
  }
  return permissions;
}

function botChannelPermissions(guildId: string, botId: string, roles: DiscordRole[], member: DiscordGuildMember, channel: DiscordChannel): bigint {
  let permissions = botBasePermissions(guildId, roles, member);
  if ((permissions & 8n) === 8n) return permissions | PANEL_PERMISSION_MASK;

  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find(o => o.id === guildId && o.type === 0);
  if (everyone) {
    permissions &= ~BigInt(everyone.deny || "0");
    permissions |= BigInt(everyone.allow || "0");
  }
  let roleAllow = 0n, roleDeny = 0n;
  for (const roleId of member.roles) {
    const overwrite = overwrites.find(o => o.id === roleId && o.type === 0);
    if (!overwrite) continue;
    roleAllow |= BigInt(overwrite.allow || "0");
    roleDeny |= BigInt(overwrite.deny || "0");
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const userOverwrite = overwrites.find(o => o.id === botId && o.type === 1);
  if (userOverwrite) {
    permissions &= ~BigInt(userOverwrite.deny || "0");
    permissions |= BigInt(userOverwrite.allow || "0");
  }
  return permissions;
}

async function botFetchInteractive(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await botFetch(env, path, { ...init, signal: controller.signal });
    if (response.status === 429) {
      const raw = await response.text().catch(() => "");
      let retryAfterSeconds: number | null = null;
      try {
        const payload = JSON.parse(raw) as { retry_after?: number };
        if (typeof payload.retry_after === "number" && Number.isFinite(payload.retry_after)) {
          retryAfterSeconds = Math.max(1, Math.ceil(payload.retry_after));
        }
      } catch {
        const header = response.headers.get("Retry-After");
        const parsed = header ? Number(header) : NaN;
        if (Number.isFinite(parsed)) retryAfterSeconds = Math.max(1, Math.ceil(parsed));
      }
      throw new HttpError(429, retryAfterSeconds
        ? `Discordのレート制限中です。約${retryAfterSeconds}秒後にもう一度保存してください`
        : "Discordのレート制限中です。少し待ってもう一度保存してください");
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpError(504, "Discord APIの応答が7秒以内に返りませんでした。権限変更は確定していないため、もう一度保存してください");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// cc-server has exactly one bot (no separate "Security Bot" to call for
// self-lockout recovery, unlike xaccount-bot's dual-bot architecture) — so
// instead of xaccount-bot's repair-via-second-bot fallback, this only ever
// prevents the lockout up front and refuses the edit if it would occur.
async function protectBotChannelAccess(env: Env, channel: DiscordChannel): Promise<void> {
  const botId = env.DISCORD_APPLICATION_ID.trim();
  const current = (channel.permission_overwrites ?? []).find(o => o.id === botId && o.type === 1);
  let allow = BigInt(current?.allow ?? "0");
  let deny = BigInt(current?.deny ?? "0");
  const alreadyProtected = (allow & BOT_CHANNEL_GUARD_MASK) === BOT_CHANNEL_GUARD_MASK && (deny & BOT_CHANNEL_GUARD_MASK) === 0n;
  if (alreadyProtected) return;

  allow |= BOT_CHANNEL_GUARD_MASK;
  deny &= ~BOT_CHANNEL_GUARD_MASK;

  const replacement = (channel.permission_overwrites ?? [])
    .filter(o => !(o.id === botId && o.type === 1))
    .map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
  replacement.push({ id: botId, type: 1, allow: allow.toString(), deny: deny.toString() });

  try {
    await botJson(env, `/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ permission_overwrites: replacement }) });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      throw new HttpError(409, "この変更を保存するとBOT自身がチャンネルから締め出される可能性があるため停止しました。対象カテゴリ/チャンネルでBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」「ロールの管理」を確認してください");
    }
    throw error;
  }
}

export async function applyChannelRolePermissions(
  env: Env, guildId: string, channel: DiscordChannel, targetId: string,
  roles: DiscordRole[], member: DiscordGuildMember, permissions: ChannelPermissionPatch
): Promise<{ allow: string; deny: string }> {
  const botId = env.DISCORD_APPLICATION_ID.trim();
  const botAdministrator = (botBasePermissions(guildId, roles, member) & 8n) === 8n;

  if (!botAdministrator && targetId !== botId) {
    const targetCanAffectBot = targetId === guildId || member.roles.includes(targetId);
    if (targetCanAffectBot) {
      const effective = botChannelPermissions(guildId, botId, roles, member, channel);
      const botCanManageChannel = (effective & 16n) === 16n || (botBasePermissions(guildId, roles, member) & 16n) === 16n;
      if (!botCanManageChannel) {
        throw new HttpError(409, "このチャンネルの権限を変更するとBOT自身が締め出される可能性があります。対象カテゴリ/チャンネルでBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」を確認してください");
      }
      await protectBotChannelAccess(env, channel);
    }
  }

  const current = (channel.permission_overwrites ?? []).find(o => o.id === targetId && o.type === 0);
  let allow = BigInt(current?.allow ?? "0");
  let deny = BigInt(current?.deny ?? "0");

  for (const [rawKey, mode] of Object.entries(permissions)) {
    if (!(rawKey in CHANNEL_PERMISSION_BITS)) continue;
    if (mode !== "inherit" && mode !== "allow" && mode !== "deny") continue;
    const bit = CHANNEL_PERMISSION_BITS[rawKey as ChannelPermissionKey];
    allow &= ~bit; deny &= ~bit;
    if (mode === "allow") allow |= bit;
    if (mode === "deny") deny |= bit;
  }

  try {
    if (allow === 0n && deny === 0n) {
      if (current) {
        const response = await botFetch(env, `/channels/${channel.id}/permissions/${targetId}`, { method: "DELETE" });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new DiscordApiError(response.status, `Discord API ${response.status}: ${detail.slice(0, 300)}`);
        }
      }
    } else {
      await botJson(env, `/channels/${channel.id}/permissions/${targetId}`, {
        method: "PUT",
        body: JSON.stringify({ type: 0, allow: allow.toString(), deny: deny.toString() }),
      });
    }
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      throw new HttpError(403, "Discordがこのチャンネルの権限変更を拒否しました。対象カテゴリ/チャンネルでBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」「ロールの管理」を確認してください");
    }
    throw error;
  }

  return { allow: allow.toString(), deny: deny.toString() };
}

export function channelPermissionPatchMatches(channel: DiscordChannel, targetId: string, permissions: ChannelPermissionPatch): boolean {
  const overwrite = (channel.permission_overwrites ?? []).find(o => o.id === targetId && o.type === 0);
  const allow = BigInt(overwrite?.allow ?? "0");
  const deny = BigInt(overwrite?.deny ?? "0");
  for (const [rawKey, mode] of Object.entries(permissions)) {
    if (!(rawKey in CHANNEL_PERMISSION_BITS)) continue;
    if (mode !== "inherit" && mode !== "allow" && mode !== "deny") continue;
    const bit = CHANNEL_PERMISSION_BITS[rawKey as ChannelPermissionKey];
    if (mode === "allow" && ((allow & bit) !== bit || (deny & bit) !== 0n)) return false;
    if (mode === "deny" && ((deny & bit) !== bit || (allow & bit) !== 0n)) return false;
    if (mode === "inherit" && ((allow & bit) !== 0n || (deny & bit) !== 0n)) return false;
  }
  return true;
}

// ── route handlers ──────────────────────────────────────────────────────────

export async function createChannel(env: Env, guildId: string, input: { name?: string; type?: "text" | "voice" | "category"; parentId?: string | null; topic?: string }): Promise<{ id: string; name: string; type: string }> {
  const name = input.name?.trim();
  if (!name || name.length > 100) throw new HttpError(400, "チャンネル名が不正です");
  const botOverwrite = [{ id: env.DISCORD_APPLICATION_ID.trim(), type: 1, allow: BOT_CHANNEL_GUARD_MASK.toString() }];
  const body = input.type === "category"
    ? { name, type: 4, permission_overwrites: botOverwrite }
    : input.type === "voice"
      ? { name, type: 2, parent_id: input.parentId || undefined, ...(input.parentId ? {} : { permission_overwrites: botOverwrite }) }
      : { name, type: 0, parent_id: input.parentId || undefined, topic: input.topic || undefined, ...(input.parentId ? {} : { permission_overwrites: botOverwrite }) };
  const created = await botJson<DiscordChannel>(env, `/guilds/${guildId}/channels`, { method: "POST", body: JSON.stringify(body) });
  return { id: created.id, name: created.name, type: input.type ?? "text" };
}

export async function patchChannel(env: Env, _guildId: string, channelId: string, input: { name?: string; parentId?: string | null; topic?: string }): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new HttpError(400, "チャンネル名が不正です");
    body.name = name;
  }
  if (input.parentId !== undefined) body.parent_id = input.parentId || null;
  if (input.topic !== undefined) body.topic = input.topic;
  if (Object.keys(body).length === 0) throw new HttpError(400, "更新する項目がありません");
  const updated = await botJson<DiscordChannel>(env, `/channels/${channelId}`, { method: "PATCH", body: JSON.stringify(body) });
  return { id: updated.id, name: updated.name };
}

export async function reorderChannel(env: Env, guildId: string, input: { id?: string; targetId?: string | null; placement?: "before" | "after" | "start"; parentId?: string | null; position?: number }): Promise<Record<string, unknown>> {
  if (!/^\d+$/.test(input.id ?? "")) throw new HttpError(400, "並び替え対象が不正です");
  const channels = await botJson<DiscordChannel[]>(env, `/guilds/${guildId}/channels`);
  const source = channels.find(c => c.id === input.id);
  if (!source) throw new HttpError(404, "移動するチャンネルが見つかりません");

  if (source.type === 4) {
    if (!Number.isInteger(input.position)) throw new HttpError(400, "カテゴリの並び替え位置が不正です");
    await botJson(env, `/guilds/${guildId}/channels`, { method: "PATCH", body: JSON.stringify([{ id: source.id, position: input.position }]) });
    return { ok: true, kind: "category" };
  }

  let destinationParent: string | null;
  let destinationIndex = 0;
  let destinationSiblings: DiscordChannel[];

  if (input.targetId) {
    const target = channels.find(c => c.id === input.targetId);
    if (!target || target.type === 4) throw new HttpError(400, "移動先チャンネルが不正です");
    if (target.id === source.id) return { ok: true, unchanged: true };
    destinationParent = target.parent_id ?? null;
    destinationSiblings = channels.filter(c => c.type !== 4 && c.id !== source.id && (c.parent_id ?? null) === destinationParent).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const targetIndex = destinationSiblings.findIndex(c => c.id === target.id);
    if (targetIndex < 0) throw new HttpError(400, "移動先を判定できませんでした");
    destinationIndex = targetIndex + (input.placement === "after" ? 1 : 0);
  } else {
    destinationParent = input.parentId ?? null;
    if (destinationParent !== null) {
      const category = channels.find(c => c.id === destinationParent && c.type === 4);
      if (!category) throw new HttpError(400, "移動先カテゴリが見つかりません");
    }
    destinationSiblings = channels.filter(c => c.type !== 4 && c.id !== source.id && (c.parent_id ?? null) === destinationParent).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    destinationIndex = input.placement === "start" ? 0 : destinationSiblings.length;
  }

  destinationIndex = Math.max(0, Math.min(destinationIndex, destinationSiblings.length));
  const reordered = [...destinationSiblings];
  reordered.splice(destinationIndex, 0, source);

  const payload = reordered.map((channel, index) => ({
    id: channel.id, position: index,
    ...(channel.id === source.id ? { parent_id: destinationParent, lock_permissions: false } : {}),
  }));
  await botJson(env, `/guilds/${guildId}/channels`, { method: "PATCH", body: JSON.stringify(payload) });

  const confirmed = await botJson<DiscordChannel[]>(env, `/guilds/${guildId}/channels`);
  const confirmedSource = confirmed.find(c => c.id === source.id);
  if (!confirmedSource || (confirmedSource.parent_id ?? null) !== destinationParent) {
    throw new HttpError(502, "Discord側でカテゴリ移動を反映できませんでした");
  }

  return {
    ok: true, id: source.id, parentId: destinationParent, targetId: input.targetId ?? null,
    placement: input.targetId ? (input.placement === "after" ? "after" : "before") : "start",
  };
}

export async function createRole(env: Env, guildId: string, input: { name?: string; color?: number; permissions?: string }): Promise<unknown> {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 100) throw new HttpError(400, "ロール名が不正です");
  const color = input.color === undefined ? 0 : Number(input.color);
  if (!Number.isInteger(color) || color < 0 || color > 0xFFFFFF) throw new HttpError(400, "ロール色が不正です");
  let permissions = "0";
  try {
    const parsed = BigInt(input.permissions ?? "0");
    if (parsed < 0n) throw new Error();
    permissions = parsed.toString();
  } catch { throw new HttpError(400, "ロール権限が不正です"); }

  try {
    const role = await botJson<DiscordRole>(env, `/guilds/${guildId}/roles`, { method: "POST", body: JSON.stringify({ name, color, permissions }) });
    return { id: role.id, name: role.name, position: role.position, color: role.color ?? 0, permissions: role.permissions, isEveryone: false };
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      throw new HttpError(403, "ロールを追加できません。BOTに「ロールの管理」権限があるか確認してください");
    }
    throw error;
  }
}

export async function patchRole(env: Env, guildId: string, roleId: string, input: { name?: string; color?: number; permissions?: string }): Promise<unknown> {
  const payload: Record<string, unknown> = {};
  if (input.permissions !== undefined) {
    try {
      const parsed = BigInt(input.permissions);
      if (parsed < 0n) throw new Error();
      payload.permissions = parsed.toString();
    } catch { throw new HttpError(400, "ロール権限が不正です"); }
  }
  if (roleId === guildId) {
    if (input.name !== undefined || input.color !== undefined) throw new HttpError(400, "@everyone は名前や色を変更できません");
  } else {
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 100) throw new HttpError(400, "ロール名が不正です");
      payload.name = name;
    }
    if (input.color !== undefined) {
      const color = Number(input.color);
      if (!Number.isInteger(color) || color < 0 || color > 0xFFFFFF) throw new HttpError(400, "ロール色が不正です");
      payload.color = color;
    }
  }
  try {
    const role = await botJson<DiscordRole>(env, `/guilds/${guildId}/roles/${roleId}`, { method: "PATCH", body: JSON.stringify(payload) });
    return { id: role.id, name: role.name, position: role.position, color: role.color ?? 0, permissions: role.permissions, isEveryone: role.id === guildId };
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      throw new HttpError(403, "このロールを編集できません。BOTの「ロールの管理」権限、またはBOTより上にあるロールの並び順を確認してください");
    }
    throw error;
  }
}

export async function deleteRole(env: Env, guildId: string, roleId: string): Promise<void> {
  if (roleId === guildId) throw new HttpError(400, "@everyone は削除できません");
  try {
    await botJson<void>(env, `/guilds/${guildId}/roles/${roleId}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      throw new HttpError(403, "このロールを削除できません。BOTの「ロールの管理」権限、またはBOTより上にあるロールの並び順を確認してください");
    }
    throw error;
  }
}

export async function patchChannelPermission(env: Env, guildId: string, channelId: string, targetId: string, permissions: ChannelPermissionPatch): Promise<{ allow: string; deny: string }> {
  if (Object.keys(permissions).length === 0) throw new HttpError(400, "変更する権限を選択してください");

  const channelsResponse = await botFetchInteractive(env, `/guilds/${guildId}/channels`);
  if (!channelsResponse.ok) {
    const detail = await channelsResponse.text().catch(() => "");
    if (channelsResponse.status === 403) {
      throw new HttpError(403, "BOTがサーバーのチャンネル一覧を取得できません。BOTがサーバーに参加しているか確認してください");
    }
    throw new DiscordApiError(channelsResponse.status, `Discord API ${channelsResponse.status}: ${detail.slice(0, 300)}`);
  }
  const channels = await channelsResponse.json() as DiscordChannel[];
  const channel = channels.find(c => c.id === channelId);
  if (!channel) throw new HttpError(404, "対象チャンネルが見つかりません。サーバー構成を再読み込みしてください");

  const roles = await botJson<DiscordRole[]>(env, `/guilds/${guildId}/roles`);
  const member = await getBotGuildMember(env, guildId, roles);
  return applyChannelRolePermissions(env, guildId, channel, targetId, roles, member, permissions);
}

// Full channel/role dataset for the server editor — unlike /api/guilds/:id/meta
// (which is shared by panels/security/amazon-vending and deliberately filters
// to text channels and non-managed, non-@everyone roles), this includes
// categories/voice channels, each channel's permission_overwrites, and
// @everyone, since the editor needs all of that as valid permission targets.
export async function getServerEditorData(env: Env, guildId: string): Promise<{
  channels: DiscordChannel[];
  roles: Array<{ id: string; name: string; color: number; position: number; permissions: string; isEveryone: boolean }>;
}> {
  const [channels, roles] = await Promise.all([
    botJson<DiscordChannel[]>(env, `/guilds/${guildId}/channels`),
    botJson<DiscordRole[]>(env, `/guilds/${guildId}/roles`),
  ]);
  return {
    channels: channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    roles: roles
      .filter(r => !r.managed)
      .map(r => ({ id: r.id, name: r.id === guildId ? "@everyone" : r.name, color: r.color, position: r.position, permissions: r.permissions ?? "0", isEveryone: r.id === guildId }))
      .sort((a, b) => b.position - a.position),
  };
}

export async function bulkChannelPermissions(env: Env, guildId: string, input: { channelIds?: string[]; targetId?: string; permissions?: ChannelPermissionPatch }): Promise<{ ok: boolean; requested: number; updatedIds: string[]; failed: Array<{ id: string; name: string; message: string }> }> {
  const channelIds = [...new Set((input.channelIds ?? []).map(id => String(id).trim()).filter(id => /^\d+$/.test(id)))];
  const targetId = String(input.targetId ?? "").trim();
  const permissions = input.permissions ?? {};
  if (channelIds.length === 0) throw new HttpError(400, "対象チャンネルを選択してください");
  if (channelIds.length > 100) throw new HttpError(400, "一度に変更できるのは100チャンネルまでです");
  if (!/^\d+$/.test(targetId)) throw new HttpError(400, "対象ロールが不正です");
  if (Object.keys(permissions).length === 0) throw new HttpError(400, "変更する権限を選択してください");

  const [channels, roles] = await Promise.all([
    botJson<DiscordChannel[]>(env, `/guilds/${guildId}/channels`),
    botJson<DiscordRole[]>(env, `/guilds/${guildId}/roles`),
  ]);
  if (targetId !== guildId && !roles.some(r => r.id === targetId)) throw new HttpError(404, "対象ロールが見つかりません");

  const member = await getBotGuildMember(env, guildId, roles);
  const channelById = new Map(channels.map(c => [c.id, c]));
  const updated: string[] = [];
  const failed: Array<{ id: string; name: string; message: string }> = [];

  for (const channelId of channelIds) {
    const channel = channelById.get(channelId);
    if (!channel || channel.type === 4) {
      failed.push({ id: channelId, name: channel?.name ?? channelId, message: "チャンネルが見つかりません" });
      continue;
    }
    try {
      await applyChannelRolePermissions(env, guildId, channel, targetId, roles, member, permissions);
      updated.push(channelId);
    } catch (error) {
      failed.push({ id: channel.id, name: channel.name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ok: failed.length === 0, requested: channelIds.length, updatedIds: updated.filter(id => !failed.some(f => f.id === id)), failed };
}
