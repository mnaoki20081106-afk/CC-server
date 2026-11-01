// Adapted from xaccount-bot's apps/worker/src/security/service.ts.
// xaccount-bot's version is an HTTP-bridge service: a separate Worker that
// verifies HMAC-signed requests from "Main Bot" before touching settings
// (verifyBridge/hmacHex/applyBridgeSecurityFloor), plus service-bot
// registration and maintenance-lease routes for coordinating two bots.
// cc-server has one bot and one Worker — the dashboard route handler in
// index.ts calls these functions directly, in-process, after its own
// DASHBOARD_PASSWORD session check. So: no HMAC verification, no security
// floor to enforce against an untrusted bridge caller (the dashboard IS the
// trusted operator here), no service-bot/maintenance routes (see db.ts).
import type { Env } from "../types";
import type { SecuritySettings } from "./types";
import {
  cleanExpired, getLockdownSnapshot, getSecuritySettings, listExpiredLockdowns, listIncidents, saveSecuritySettings,
} from "./db";
import { botJson, enterLockdown, exitLockdown, getGuildSafetyStatus, getSecurityCapabilities } from "./discord";
import { DiscordSecurityGateway, ensureDiscordSecurityGateway, gatewayStatus, reconcileDiscordSecurityAudits } from "./gateway";

export { DiscordSecurityGateway };

async function invalidateGatewaySettings(env: Env, guildId: string): Promise<void> {
  const id = env.SECURITY_GATEWAY.idFromName("discord-security");
  await env.SECURITY_GATEWAY.get(id).fetch("https://security-gateway.internal/invalidate/" + encodeURIComponent(guildId), { method: "POST" }).catch(() => undefined);
}

export function settingsPatch(body: unknown): Partial<SecuritySettings> {
  if (!body || typeof body !== "object") return {};
  const input = body as Partial<SecuritySettings>;
  const patch: Partial<SecuritySettings> = {};
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (input.mode === "audit" || input.mode === "enforce") patch.mode = input.mode;
  if (["balanced", "strict", "paranoid"].includes(String(input.profile))) patch.profile = input.profile;
  if (input.modules && typeof input.modules === "object") patch.modules = input.modules;
  if (input.response && typeof input.response === "object") patch.response = input.response;
  if (input.safety && typeof input.safety === "object") {
    const raw = input.safety as Partial<SecuritySettings["safety"]>;
    patch.safety = {
      enforceExplicitContentFilter: typeof raw.enforceExplicitContentFilter === "boolean" ? raw.enforceExplicitContentFilter : true,
      minimumVerificationLevel: Math.max(0, Math.min(4, Math.trunc(Number(raw.minimumVerificationLevel ?? 2)))),
    };
  }
  if (input.thresholds && typeof input.thresholds === "object") {
    const limits: Record<string, [number, number]> = {
      actionWindowSeconds: [2, 120], crossActionWindowSeconds: [5, 300], crossActionScore: [4, 100],
      channelDelete: [1, 30], channelCreate: [1, 50], channelUpdate: [1, 50], channelOverwrite: [1, 50],
      roleDelete: [1, 30], roleCreate: [1, 50], roleUpdate: [1, 50], banAdd: [1, 50], memberPrune: [1, 100000],
      kick: [1, 50], webhook: [1, 30], botAdd: [1, 10], guildUpdate: [1, 20], automodChange: [1, 20],
      raidJoins: [2, 1000], raidWindowSeconds: [2, 300], spamMessages: [2, 50], spamWindowSeconds: [1, 120],
      mentionLimit: [2, 100], linkBurst: [2, 50], linkWindowSeconds: [2, 300], severeContentUsers: [2, 50],
      severeContentWindowSeconds: [5, 300], minAccountAgeHours: [0, 87600],
    };
    const normalized: Record<string, number> = {};
    for (const [key, range] of Object.entries(limits)) {
      const value = Number((input.thresholds as unknown as Record<string, unknown>)[key]);
      if (!Number.isFinite(value)) continue;
      normalized[key] = Math.max(range[0], Math.min(range[1], Math.trunc(value)));
    }
    patch.thresholds = normalized as unknown as SecuritySettings["thresholds"];
  }
  for (const key of ["trustedUserIds", "trustedRoleIds", "allowedBotIds", "allowedDomains", "blockedDomains"] as const) {
    const value = input[key];
    if (Array.isArray(value)) (patch as Record<string, unknown>)[key] = value.map(item => String(item).trim()).filter(Boolean).slice(0, 500);
  }
  if (input.logChannelId === null || typeof input.logChannelId === "string") patch.logChannelId = input.logChannelId || null;
  return patch;
}

export function isManualDashboardLockdown(reason: string | null | undefined): boolean {
  return reason === "manual dashboard lockdown";
}

export type SecurityOverview = Awaited<ReturnType<typeof getSecurityOverview>>;

export async function getSecurityOverview(env: Env, guildId: string, incidentLimit = 30) {
  const settings = await getSecuritySettings(env, guildId);
  const [status, incidents, lockdown, guild, capabilities, safetyStatus] = await Promise.all([
    gatewayStatus(env),
    listIncidents(env, guildId, incidentLimit),
    getLockdownSnapshot(env, guildId),
    botJson<{ id: string; name: string }>(env, `/guilds/${guildId}`).catch(() => null),
    getSecurityCapabilities(env, guildId),
    getGuildSafetyStatus(env, guildId, settings).catch(() => null),
  ]);
  const permissions = (128n | 32n | 268435456n | 16n | 536870912n | 8192n | 1099511627776n | 2n | 4n | 1024n | 2048n | 16384n).toString();
  return {
    configured: true,
    installed: Boolean(guild),
    capabilities,
    safetyStatus,
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(env.DISCORD_APPLICATION_ID)}&permissions=${permissions}&integration_type=0&scope=bot%20applications.commands`,
    maximumInviteUrl: `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(env.DISCORD_APPLICATION_ID)}&permissions=8&integration_type=0&scope=bot%20applications.commands`,
    settings,
    status,
    incidents,
    lockdown: lockdown
      ? { active: true, expiresAt: lockdown.expiresAt, reason: lockdown.reason, manualUnlockAllowed: isManualDashboardLockdown(lockdown.reason) }
      : { active: false, expiresAt: null, reason: null, manualUnlockAllowed: false },
  };
}

export async function updateSecuritySettings(env: Env, guildId: string, body: unknown): Promise<SecuritySettings> {
  const saved = await saveSecuritySettings(env, guildId, settingsPatch(body));
  await invalidateGatewaySettings(env, guildId);
  return saved;
}

export async function triggerLockdown(env: Env, guildId: string, minutes?: number): Promise<{ ok: true; changed: boolean }> {
  const settings = await getSecuritySettings(env, guildId);
  const changed = await enterLockdown(env, guildId, Number(minutes ?? settings.response.lockdownMinutes), "manual dashboard lockdown");
  return { ok: true, changed };
}

export async function releaseLockdown(env: Env, guildId: string): Promise<{ ok: true; changed: boolean } | { error: string; message: string; expiresAt: number }> {
  const snapshot = await getLockdownSnapshot(env, guildId);
  if (snapshot && !isManualDashboardLockdown(snapshot.reason)) {
    return {
      error: "automatic_lockdown_protected",
      message: "自動防御で発動したLockdownは手動で解除できません。期限切れを待つか、しきい値を調整してください。",
      expiresAt: snapshot.expiresAt,
    };
  }
  return { ok: true, changed: await exitLockdown(env, guildId) };
}

export async function ensureSecurityGatewayRunning(env: Env): Promise<void> {
  await ensureDiscordSecurityGateway(env);
}

export async function runSecurityScheduled(env: Env): Promise<void> {
  await cleanExpired(env);
  await ensureDiscordSecurityGateway(env);
  await reconcileDiscordSecurityAudits(env).catch(error => console.error("scheduled audit reconciliation failed", error));
  for (const guildId of await listExpiredLockdowns(env)) {
    await exitLockdown(env, guildId).catch(error => console.error("lockdown restore failed", guildId, error));
  }
}
