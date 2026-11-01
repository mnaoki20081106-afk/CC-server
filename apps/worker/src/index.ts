import type { Env } from "./types";
import {
  ensureSchema, createDashboardSession, getDashboardSession, cleanExpiredSessions,
  getGuildConfig, updateGuildConfig,
  listPanels, createPanel, getPanel, updatePanelPost, listPanelButtons, createPanelButton, deletePanelButton, getPanelButton,
  getAvConfig, upsertAvConfig, cleanExpiredAvSessions,
  replaceBotGuildCache, listBotGuildCache,
} from "./db";
import { verifyInteraction, botJson, DiscordApiError, type DiscordChannel, type DiscordRole } from "./discord";
import { sha256Hex, randomToken, corsHeaders, json } from "./utils";
import { handleAvBuyButton, handleAvUrlModal, handleAvSelect, handleAvNext, handleAvAddrModal } from "./amazon-vending";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Invite / applications.commands + manage roles, channels, messages — the
// permissions cc-server's features actually use.
const BOT_PERMISSIONS = (
  1n << 0n |   // CREATE_INSTANT_INVITE
  1n << 4n |   // MANAGE_CHANNELS
  1n << 10n |  // VIEW_CHANNEL
  1n << 11n |  // SEND_MESSAGES
  1n << 13n |  // MANAGE_MESSAGES
  1n << 16n |  // READ_MESSAGE_HISTORY
  1n << 28n |  // MANAGE_ROLES
  1n << 2n     // BAN_MEMBERS
).toString();

// ── auth ──────────────────────────────────────────────────────────────────────

async function sessionFromRequest(request: Request, env: Env): Promise<void> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) throw new HttpError(401, "ログインが必要です");
  const raw = auth.slice(7).trim();
  const row = await getDashboardSession(env, await sha256Hex(raw));
  if (!row) throw new HttpError(401, "セッションが失効しています");
}

// ── Discord interaction handling ──────────────────────────────────────────────

function interactionResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function ephemeral(content: string): unknown {
  return { type: 4, data: { content, flags: 64 } };
}

const STYLE_MAP: Record<string, number> = {
  Primary: 1, Secondary: 2, Success: 3, Danger: 4,
};

async function processInteraction(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const type = interaction.type as number;
  const customId = String(interaction.data?.custom_id ?? "");

  // ping
  if (type === 1) return interactionResponse({ type: 1 });

  // Amazon自販機 button: av:buy:<guildId>
  if (type === 3 && customId.startsWith("av:buy:")) {
    return handleAvBuyButton(interaction, env);
  }

  // Amazon自販機 modal: av:url_modal:<guildId>
  if (type === 5 && customId.startsWith("av:url_modal:")) {
    return handleAvUrlModal(interaction, env, ctx);
  }

  // Amazon自販機 select: av:select:<sessionId>
  if (type === 3 && customId.startsWith("av:select:")) {
    return handleAvSelect(interaction);
  }

  // Amazon自販機 next button: av:next:<sessionId>
  if (type === 3 && customId.startsWith("av:next:")) {
    return handleAvNext(interaction);
  }

  // Amazon自販機 address modal: av:addr_modal:<sessionId>[:<variantAsin>:<priceJpy>]
  if (type === 5 && customId.startsWith("av:addr_modal:")) {
    return handleAvAddrModal(interaction, env, ctx);
  }

  // Panel button: panel:<buttonId>
  if (type === 3 && customId.startsWith("panel:")) {
    await ensureSchema(env);
    const btnId = parseInt(customId.slice(6), 10);
    const btn = await getPanelButton(env, btnId);
    if (!btn) return interactionResponse(ephemeral("このボタンは無効です。"));

    if (btn.action_type === "toggle_role") {
      const guildId = String(interaction.guild_id ?? "");
      const userId = String(interaction.member?.user?.id ?? "");
      const roleId = btn.action_value;
      const hasRole = (interaction.member?.roles as string[] ?? []).includes(roleId);
      try {
        if (hasRole) {
          await botJson(env, `/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "DELETE" });
          return interactionResponse(ephemeral(`ロール <@&${roleId}> を外しました。`));
        } else {
          await botJson(env, `/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "PUT" });
          return interactionResponse(ephemeral(`ロール <@&${roleId}> を付与しました。`));
        }
      } catch (err) {
        if (err instanceof DiscordApiError && err.status === 403) {
          return interactionResponse(ephemeral("BOTの権限が不足しています。"));
        }
        throw err;
      }
    }

    if (btn.action_type === "show_text") {
      return interactionResponse(ephemeral(btn.action_value.slice(0, 2000)));
    }

    return interactionResponse(ephemeral("未対応のアクションです。"));
  }

  return interactionResponse(ephemeral("未対応の操作です。"));
}

async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!await verifyInteraction(env, request, body)) {
    return new Response("invalid signature", { status: 401 });
  }
  const interaction = JSON.parse(body);
  await ensureSchema(env);
  return processInteraction(interaction, env, ctx);
}

// ── admin API ─────────────────────────────────────────────────────────────────

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // login — no auth required
  if (path === "/api/login" && method === "POST") {
    if (!env.DASHBOARD_PASSWORD) throw new HttpError(503, "管理画面パスワードが未設定です");
    const { password } = await request.json() as { password?: string };
    if (!password) throw new HttpError(400, "パスワードを入力してください");
    const [actual, expected] = await Promise.all([sha256Hex(password), sha256Hex(env.DASHBOARD_PASSWORD)]);
    if (actual !== expected) throw new HttpError(401, "パスワードが違います");
    const raw = randomToken(32);
    await ensureSchema(env);
    await createDashboardSession(env, await sha256Hex(raw), Date.now() + 30 * 24 * 60 * 60_000);
    return json({ token: raw }, { env });
  }

  // all other routes require auth
  await sessionFromRequest(request, env);
  await ensureSchema(env);

  // GET /api/status
  if (path === "/api/status" && method === "GET") {
    let discordReady = false;
    let discordError: string | null = null;
    let guildCount: number | null = null;
    try {
      await botJson(env, "/users/@me");
      discordReady = true;
      const guilds = await botJson<unknown[]>(env, "/users/@me/guilds");
      guildCount = guilds.length;
    } catch (err) {
      discordError = err instanceof Error ? err.message : String(err);
    }
    return json({
      discordReady,
      discordError,
      guildCount,
      runtime: "cloudflare-workers",
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APPLICATION_ID}&permissions=${BOT_PERMISSIONS}&integration_type=0&scope=bot%20applications.commands`,
    }, { env });
  }

  // GET /api/guilds
  if (path === "/api/guilds" && method === "GET") {
    try {
      const guilds = await botJson<Array<{ id: string; name: string; icon: string | null }>>(env, `/users/@me/guilds`);
      await replaceBotGuildCache(env, guilds).catch(err => console.error("bot guild cache update failed", err));
      return json(guilds, { env });
    } catch (err) {
      // Discord's aggregate guild-list endpoint can lag transiently right
      // after an invite; fall back to the last known-good snapshot instead
      // of showing an empty sidebar.
      const cached = await listBotGuildCache(env).catch(() => []);
      if (cached.length > 0) {
        console.warn("bot guild list: live call failed, serving cache", err);
        return json(cached, { env });
      }
      throw err;
    }
  }

  // /api/guilds/:guildId/...
  const guildMatch = path.match(/^\/api\/guilds\/(\d+)(\/.*)?$/);
  if (!guildMatch) throw new HttpError(404, "not found");
  const guildId = guildMatch[1]!;
  const sub = guildMatch[2] ?? "/";

  // GET /api/guilds/:id/meta
  if (sub === "/meta" && method === "GET") {
    const [channels, roles] = await Promise.all([
      botJson<DiscordChannel[]>(env, `/guilds/${guildId}/channels`),
      botJson<DiscordRole[]>(env, `/guilds/${guildId}/roles`),
    ]);
    const guild = await botJson<{ id: string; name: string; icon: string | null }>(env, `/guilds/${guildId}`);
    return json({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      channels: channels
        .filter(c => [0, 5].includes(c.type))
        .map(c => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parent_id ?? null })),
      roles: roles
        .filter(r => !r.managed && r.id !== guildId)
        .map(r => ({ id: r.id, name: r.name, color: r.color })),
    }, { env });
  }

  // GET/PUT /api/guilds/:id/config
  if (sub === "/config") {
    if (method === "GET") return json(await getGuildConfig(env, guildId), { env });
    if (method === "PUT") {
      const body = await request.json() as Record<string, unknown>;
      const ALLOWED = new Set([
        "admin_role_id", "mod_role_id", "log_channel_id", "verified_role_id", "verify_channel_id",
        "welcome_channel_id", "welcome_message", "leave_channel_id", "leave_message",
        "ticket_category_id", "ticket_log_channel_id",
        "anti_spam_enabled", "anti_spam_threshold", "anti_spam_window_ms",
        "anti_link_enabled", "anti_link_whitelist",
        "raid_protection_enabled", "raid_join_threshold", "raid_window_ms", "raid_action",
      ]);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) if (ALLOWED.has(k)) fields[k] = v;
      await updateGuildConfig(env, guildId, fields);
      return json({ ok: true }, { env });
    }
  }

  // GET /api/guilds/:id/panels
  if (sub === "/panels" && method === "GET") return json(await listPanels(env, guildId), { env });

  // POST /api/guilds/:id/panels
  if (sub === "/panels" && method === "POST") {
    const body = await request.json() as { title?: string; description?: string };
    const title = String(body.title ?? "").trim();
    if (!title) throw new HttpError(400, "title is required");
    const id = await createPanel(env, guildId, title, body.description ? String(body.description).trim() : null);
    return json({ id }, { env });
  }

  // Panel sub-routes
  const panelMatch = sub.match(/^\/panels\/(\d+)(\/.*)?$/);
  if (panelMatch) {
    const panelId = parseInt(panelMatch[1]!, 10);
    const panelSub = panelMatch[2] ?? "/";
    const panel = await getPanel(env, panelId, guildId);
    if (!panel) throw new HttpError(404, "パネルが見つかりません");

    // GET /panels/:id/buttons
    if (panelSub === "/buttons" && method === "GET") return json(await listPanelButtons(env, panelId), { env });

    // POST /panels/:id/buttons
    if (panelSub === "/buttons" && method === "POST") {
      const body = await request.json() as any;
      const label = String(body.label ?? "").trim();
      const style = ["Primary", "Secondary", "Success", "Danger"].includes(body.style) ? body.style : "Primary";
      const emoji = body.emoji ? String(body.emoji).trim() : null;
      const actionType = ["toggle_role", "show_text"].includes(body.action_type) ? body.action_type : null;
      const actionValue = String(body.action_value ?? "").trim();
      if (!label || !actionType || !actionValue) throw new HttpError(400, "label, action_type, action_value required");
      await createPanelButton(env, panelId, label, style, emoji, actionType, actionValue);
      return json({ ok: true }, { env });
    }

    // DELETE /panels/:id/buttons/:btnId
    const btnMatch = panelSub.match(/^\/buttons\/(\d+)$/);
    if (btnMatch && method === "DELETE") {
      await deletePanelButton(env, parseInt(btnMatch[1]!, 10), panelId);
      return json({ ok: true }, { env });
    }

    // POST /panels/:id/post
    if (panelSub === "/post" && method === "POST") {
      const { channel_id } = await request.json() as { channel_id?: string };
      if (!channel_id) throw new HttpError(400, "channel_id required");
      const buttons = await listPanelButtons(env, panelId);
      const components = [];
      for (let i = 0; i < buttons.length; i += 5) {
        components.push({
          type: 1,
          components: buttons.slice(i, i + 5).map(b => ({
            type: 2,
            custom_id: `panel:${b.id}`,
            label: b.label,
            style: STYLE_MAP[b.style] ?? 1,
            ...(b.emoji ? { emoji: { name: b.emoji } } : {}),
          })),
        });
      }
      const embed: any = { title: panel.title, color: 0x9b59b6 };
      if (panel.description) embed.description = panel.description;
      const msg = await botJson<{ id: string }>(env, `/channels/${channel_id}/messages`, {
        method: "POST",
        body: JSON.stringify({ embeds: [embed], components }),
      });
      await updatePanelPost(env, panelId, msg.id, channel_id);
      return json({ ok: true }, { env });
    }

    throw new HttpError(404, "not found");
  }

  // GET/PUT /api/guilds/:id/amazon-vending
  if (sub === "/amazon-vending" || sub === "/amazon-vending/") {
    if (method === "GET") return json(await getAvConfig(env, guildId), { env });
    if (method === "PUT") {
      const body = await request.json() as any;
      const title = String(body.panel_title ?? "Amazon自販機").slice(0, 100);
      const desc = String(body.panel_description ?? "").slice(0, 500);
      const ltc = String(body.ltc_address ?? "").trim();
      const apiType = ["rainforest", "keepa", "canopy"].includes(body.api_type) ? body.api_type : "rainforest";
      const apiKey = String(body.api_key ?? "").trim();
      await upsertAvConfig(env, { guild_id: guildId, panel_title: title, panel_description: desc || null, ltc_address: ltc || null, api_type: apiType, api_key: apiKey || null });
      return json({ ok: true }, { env });
    }
  }

  // POST /api/guilds/:id/amazon-vending/panel
  if (sub === "/amazon-vending/panel" && method === "POST") {
    const { channel_id } = await request.json() as { channel_id?: string };
    if (!channel_id) throw new HttpError(400, "channel_id required");
    const cfg = await getAvConfig(env, guildId);
    const msg = await botJson<{ id: string }>(env, `/channels/${channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        embeds: [{
          title: cfg.panel_title,
          description: cfg.panel_description ?? "Amazon商品をLTCで購入できます。",
          color: 0xff9900,
          footer: { text: "購入するボタンを押してAmazonのURLを入力してください" },
        }],
        components: [{
          type: 1,
          components: [{
            type: 2,
            custom_id: `av:buy:${guildId}`,
            label: "購入する",
            style: 1,
            emoji: { name: "🛒" },
          }],
        }],
      }),
    });
    return json({ ok: true, message_id: msg.id }, { env });
  }

  throw new HttpError(404, "not found");
}

// ── main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/interactions" && request.method === "POST") {
        return handleInteraction(request, env, ctx);
      }

      if (url.pathname.startsWith("/api/")) {
        const res = await handleApi(request, env, url);
        return res;
      }

      return new Response("cc-server worker", { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, { status: err.status, env });
      }
      if (err instanceof DiscordApiError) {
        return json({ error: `Discord APIエラー: ${err.message}` }, { status: 502, env });
      }
      console.error("worker error", err);
      return json({ error: "内部エラーが発生しました" }, { status: 500, env });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      ensureSchema(env).then(() => cleanExpiredSessions(env)).catch(console.error),
      ensureSchema(env).then(() => cleanExpiredAvSessions(env)).catch(console.error),
    ]));
  },
} satisfies ExportedHandler<Env>;
