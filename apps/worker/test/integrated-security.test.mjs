// CC-server 統合テスト: Discord-Security が同じ Worker 内で動き、
// Main (Discord-Bot) のセキュリティブリッジから到達できることを確認する。
// Amazon自販機の設定APIが引き続き動くことも確認する。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
const guild = { id: guildId, name: 'Integrated server', icon: null };

async function runtime(t) {
  const calls = [];
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB', 'SECURITY_DB'],
    durableObjects: {
      DISCORD_GATEWAY: 'DiscordGateway',
      SECURITY_GATEWAY: 'DiscordSecurityGateway'
    },
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId,
      DISCORD_PUBLIC_KEY: '0'.repeat(64),
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname });
      assert.equal(url.hostname, 'discord.com', 'tests must only talk to the mocked Discord API');
      const path = url.pathname.replace(/^\/api\/v10/, '');
      if (path === '/users/@me') return Response.json({ id: botId, username: 'cc-server' });
      if (path === '/gateway/bot') return Response.json({ message: 'unavailable in tests' }, { status: 503 });
      if (path === `/guilds/${guildId}`) {
        return Response.json({ ...guild, owner_id: '1', roles: [], explicit_content_filter: 2, verification_level: 2, mfa_level: 1, features: [] });
      }
      if (path.endsWith('/roles') || path.endsWith('/channels') || path.endsWith('/webhooks')) return Response.json([]);
      if (path.includes('/members/')) return Response.json({ roles: [], user: { id: path.split('/').pop() } });
      if (path.includes('/audit-logs')) return Response.json({ audit_log_entries: [], users: [] });
      return Response.json({ message: 'not mocked' }, { status: 404 });
    }
  });
  t.after(() => mf.dispose());
  return { mf, calls };
}

async function login(mf) {
  const response = await mf.dispatchFetch('https://worker.example/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'local-test-password' })
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { token } = await response.json();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

test('security center reaches the in-Worker Discord-Security through the signed bridge', async t => {
  const { mf } = await runtime(t);
  const headers = await login(mf);
  const response = await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/security-center`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.notEqual(body.unreachable, true, body.message);
  assert.ok(body.settings, 'security settings must come from the integrated Security service');
  assert.equal(body.mainBotApplicationIdConfigured, true);

  // Security keeps its own D1 (original design: separate failure domain / storage).
  const securityDb = await mf.getD1Database('SECURITY_DB');
  const securityTables = await securityDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='security_settings'").all();
  assert.equal(securityTables.results.length, 1);
  const mainDb = await mf.getD1Database('DB');
  const mainSecurityTables = await mainDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='security_settings'").all();
  assert.equal(mainSecurityTables.results.length, 0);
});

test('security settings saved from the dashboard persist in the integrated Security service', async t => {
  const { mf } = await runtime(t);
  const headers = await login(mf);
  const before = await (await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/security-center`, { headers })).json();
  const save = await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/security-center`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...before.settings,
      mode: 'audit',
      thresholds: { ...before.settings.thresholds, raidJoins: 7 }
    })
  });
  assert.equal(save.status, 200, await save.clone().text());
  const after = await (await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/security-center`, { headers })).json();
  assert.equal(after.settings.thresholds.raidJoins, 7);
  // Discord-Security のブリッジ下限: Main 側からは enforce を解除できない
  assert.equal(after.settings.mode, 'enforce');
});

test('unsigned requests to the Security internal API are rejected', async t => {
  const { mf } = await runtime(t);
  const response = await mf.dispatchFetch(`https://worker.example/internal/guilds/${guildId}/overview`);
  assert.notEqual(response.status, 200);
});

test('Amazon vending config API keeps working', async t => {
  const { mf } = await runtime(t);
  const headers = await login(mf);
  const initial = await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/amazon-vending`, { headers });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).panel_title, 'Amazon自販機');
  const save = await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/amazon-vending`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ panel_title: 'テスト自販機', panel_description: '説明', ltc_address: 'ltc1qtest', api_type: 'keepa', api_key: 'k' })
  });
  assert.equal(save.status, 200);
  const saved = await (await mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/amazon-vending`, { headers })).json();
  assert.equal(saved.panel_title, 'テスト自販機');
  assert.equal(saved.api_type, 'keepa');
});
