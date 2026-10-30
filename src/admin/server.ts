import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type TextChannel } from 'discord.js';
import { db, getGuildConfig, updateGuildConfig } from '../db.js';
import { config } from '../config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

// ── session store ────────────────────────────────────────────────────────────

const sessions = new Set<string>();

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function checkAuth(req: IncomingMessage): boolean {
  const token = req.headers['x-admin-token'] as string | undefined;
  return !!token && sessions.has(token);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function jsonRes(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

function notFound(res: ServerResponse) { jsonRes(res, 404, { error: 'not found' }); }
function unauthorized(res: ServerResponse) { jsonRes(res, 401, { error: 'unauthorized' }); }

function serveFile(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath)) { notFound(res); return; }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
  res.end(readFileSync(filePath));
}

// ── route handler ─────────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse, client: Client) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-admin-token,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' });
    res.end();
    return;
  }

  // Static files
  if (path === '/' || path === '/index.html') { serveFile(res, join(PUBLIC, 'index.html')); return; }
  if (!path.startsWith('/admin/api/')) {
    const filePath = join(PUBLIC, path.replace(/^\//, ''));
    serveFile(res, filePath);
    return;
  }

  // Login
  if (path === '/admin/api/login' && method === 'POST') {
    const body = await readBody(req);
    const adminPass = config.adminPassword;
    if (!adminPass) { jsonRes(res, 503, { error: 'ADMIN_PASSWORD not set' }); return; }
    if (body.password !== adminPass) { jsonRes(res, 401, { error: 'パスワードが違います' }); return; }
    const token = randomToken();
    sessions.add(token);
    jsonRes(res, 200, { token });
    return;
  }

  // All routes below require auth
  if (!checkAuth(req)) { unauthorized(res); return; }

  // GET /admin/api/guilds
  if (path === '/admin/api/guilds' && method === 'GET') {
    const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.icon }));
    jsonRes(res, 200, guilds);
    return;
  }

  // /admin/api/guilds/:guildId/...
  const guildMatch = path.match(/^\/admin\/api\/guilds\/(\d+)(\/.*)?$/);
  if (!guildMatch) { notFound(res); return; }
  const guildId = guildMatch[1]!;
  const sub = guildMatch[2] ?? '/';

  const guild = client.guilds.cache.get(guildId);
  if (!guild) { jsonRes(res, 404, { error: 'BOTがそのサーバーにいません' }); return; }

  // GET /admin/api/guilds/:id/meta
  if (sub === '/meta' && method === 'GET') {
    const channels = guild.channels.cache
      .filter(c => c.isTextBased() && !c.isThread())
      .map(c => ({ id: c.id, name: c.name, type: c.type }));
    const roles = guild.roles.cache
      .filter(r => !r.managed && r.id !== guild.id)
      .map(r => ({ id: r.id, name: r.name, color: r.color }));
    jsonRes(res, 200, { id: guild.id, name: guild.name, icon: guild.icon, channels: [...channels], roles: [...roles] });
    return;
  }

  // GET/PUT /admin/api/guilds/:id/config
  if (sub === '/config') {
    if (method === 'GET') {
      jsonRes(res, 200, getGuildConfig(guildId));
      return;
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const allowed = new Set([
        'admin_role_id','mod_role_id','log_channel_id','verified_role_id','verify_channel_id',
        'welcome_channel_id','welcome_message','leave_channel_id','leave_message',
        'ticket_category_id','ticket_log_channel_id',
        'anti_spam_enabled','anti_spam_threshold','anti_spam_window_ms',
        'anti_link_enabled','anti_link_whitelist',
        'raid_protection_enabled','raid_join_threshold','raid_window_ms','raid_action'
      ]);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (allowed.has(k)) fields[k] = v;
      }
      updateGuildConfig(guildId, fields);
      jsonRes(res, 200, { ok: true });
      return;
    }
  }

  // GET /admin/api/guilds/:id/panels
  if (sub === '/panels' && method === 'GET') {
    const panels = db.prepare('SELECT * FROM panels WHERE guild_id = ? ORDER BY id').all(guildId);
    jsonRes(res, 200, panels);
    return;
  }

  // POST /admin/api/guilds/:id/panels
  if (sub === '/panels' && method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    const description = body.description ? String(body.description).trim() : null;
    if (!title) { jsonRes(res, 400, { error: 'title is required' }); return; }
    const result = db.prepare(
      'INSERT INTO panels (guild_id, title, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(guildId, title, description, 'admin', Date.now());
    jsonRes(res, 200, { id: result.lastInsertRowid });
    return;
  }

  // Panel sub-routes
  const panelMatch = sub.match(/^\/panels\/(\d+)(\/.*)?$/);
  if (panelMatch) {
    const panelId = parseInt(panelMatch[1]!, 10);
    const panelSub = panelMatch[2] ?? '/';
    const panel = db.prepare('SELECT * FROM panels WHERE id = ? AND guild_id = ?').get(panelId, guildId) as any;
    if (!panel) { jsonRes(res, 404, { error: 'パネルが見つかりません' }); return; }

    // GET /panels/:id/buttons
    if (panelSub === '/buttons' && method === 'GET') {
      const buttons = db.prepare('SELECT * FROM panel_buttons WHERE panel_id = ?').all(panelId);
      jsonRes(res, 200, buttons);
      return;
    }

    // POST /panels/:id/buttons
    if (panelSub === '/buttons' && method === 'POST') {
      const body = await readBody(req);
      const label = String(body.label ?? '').trim();
      const style = ['Primary','Secondary','Success','Danger'].includes(body.style) ? body.style : 'Primary';
      const emoji = body.emoji ? String(body.emoji).trim() : null;
      const actionType = ['toggle_role','show_text'].includes(body.action_type) ? body.action_type : null;
      const actionValue = String(body.action_value ?? '').trim();
      if (!label || !actionType || !actionValue) { jsonRes(res, 400, { error: 'label, action_type, action_value required' }); return; }
      db.prepare(
        'INSERT INTO panel_buttons (panel_id, label, style, emoji, action_type, action_value) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(panelId, label, style, emoji, actionType, actionValue);
      jsonRes(res, 200, { ok: true });
      return;
    }

    // DELETE /panels/:id/buttons/:buttonId
    const btnMatch = panelSub.match(/^\/buttons\/(\d+)$/);
    if (btnMatch && method === 'DELETE') {
      db.prepare('DELETE FROM panel_buttons WHERE id = ? AND panel_id = ?').run(parseInt(btnMatch[1]!), panelId);
      jsonRes(res, 200, { ok: true });
      return;
    }

    // POST /panels/:id/post
    if (panelSub === '/post' && method === 'POST') {
      const body = await readBody(req);
      const channelId = String(body.channel_id ?? '').trim();
      const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
      if (!channel?.isTextBased()) { jsonRes(res, 400, { error: '有効なテキストチャンネルではありません' }); return; }
      const buttons = db.prepare('SELECT * FROM panel_buttons WHERE panel_id = ?').all(panelId) as any[];
      const STYLE_MAP: Record<string, ButtonStyle> = {
        Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary,
        Success: ButtonStyle.Success, Danger: ButtonStyle.Danger
      };
      const embed = new EmbedBuilder().setTitle(panel.title).setColor(0x9b59b6);
      if (panel.description) embed.setDescription(panel.description);
      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        const chunk = buttons.slice(i, i + 5);
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          chunk.map((b: any) => new ButtonBuilder().setCustomId(`panel:${b.id}`).setLabel(b.label).setStyle(STYLE_MAP[b.style] ?? ButtonStyle.Primary))
        ));
      }
      const msg = await (channel as TextChannel).send({ embeds: [embed], components: rows as any });
      db.prepare('UPDATE panels SET message_id = ?, channel_id = ? WHERE id = ?').run(msg.id, channel.id, panelId);
      jsonRes(res, 200, { ok: true });
      return;
    }

    notFound(res);
    return;
  }

  // GET/PUT /admin/api/guilds/:id/amazon-vending
  if (sub === '/amazon-vending' || sub === '/amazon-vending/') {
    if (method === 'GET') {
      const row = db.prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?').get(guildId) as any;
      jsonRes(res, 200, row ?? {
        guild_id: guildId, panel_title: 'Amazon自販機',
        panel_description: 'Amazon商品をLTCで購入できます。',
        ltc_address: '', api_type: 'rainforest', api_key: ''
      });
      return;
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const title = String(body.panel_title ?? 'Amazon自販機').slice(0, 100);
      const desc = String(body.panel_description ?? '').slice(0, 500);
      const ltc = String(body.ltc_address ?? '').trim();
      const apiType = ['rainforest','keepa','canopy'].includes(body.api_type) ? body.api_type : 'rainforest';
      const apiKey = String(body.api_key ?? '').trim();
      db.prepare(
        `INSERT INTO amazon_vending_config(guild_id,panel_title,panel_description,ltc_address,api_type,api_key)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(guild_id) DO UPDATE SET
           panel_title=excluded.panel_title, panel_description=excluded.panel_description,
           ltc_address=excluded.ltc_address, api_type=excluded.api_type, api_key=excluded.api_key`
      ).run(guildId, title, desc, ltc, apiType, apiKey);
      jsonRes(res, 200, { ok: true });
      return;
    }
  }

  // POST /admin/api/guilds/:id/amazon-vending/panel
  if (sub === '/amazon-vending/panel' && method === 'POST') {
    const body = await readBody(req);
    const channelId = String(body.channel_id ?? '').trim();
    const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel?.isTextBased()) { jsonRes(res, 400, { error: '有効なテキストチャンネルではありません' }); return; }
    const cfg = db.prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?').get(guildId) as any;
    const embed = new EmbedBuilder()
      .setTitle(cfg?.panel_title ?? 'Amazon自販機')
      .setDescription(cfg?.panel_description ?? 'Amazon商品をLTCで購入できます。')
      .setColor(0xff9900)
      .setFooter({ text: '購入するボタンを押してAmazonのURLを入力してください' });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`av:buy:${guildId}`).setLabel('購入する').setStyle(ButtonStyle.Primary).setEmoji('🛒')
    );
    await (channel as TextChannel).send({ embeds: [embed], components: [row] });
    jsonRes(res, 200, { ok: true });
    return;
  }

  notFound(res);
}

// ── start ─────────────────────────────────────────────────────────────────────

export function startAdminServer(client: Client): void {
  const port = config.adminPort;
  if (!port) return;

  const server = createServer((req, res) => {
    handleRequest(req, res, client).catch(err => {
      console.error('[admin] error:', err);
      if (!res.headersSent) jsonRes(res, 500, { error: 'internal server error' });
    });
  });

  server.listen(port, () => {
    console.log(`[admin] server running on http://localhost:${port}`);
  });
}
