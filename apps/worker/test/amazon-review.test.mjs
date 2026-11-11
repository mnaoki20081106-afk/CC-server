// Amazon自販機: 購入チャンネルの実績投稿パネル → 感想+画像モーダル → 実績チャンネルへ送信
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
const buyerId = '323456789012345678';
const otherId = '423456789012345678';
const reviewChannelId = '523456789012345678';
const ticketChannelId = '623456789012345678';
const panelMessageId = '723456789012345678';
const attachmentId = '823456789012345678';
const imageBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function runtime(t) {
  const calls = [];
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const discordPublicKey = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('hex');
  let messageSeq = 900000000000000000n;
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId,
      DISCORD_PUBLIC_KEY: discordPublicKey,
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/',
      GOOGLE_PLACES_API_KEY: 'places-test-key'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      const entry = { method: request.method, host: url.hostname, path: url.pathname, contentType: request.headers.get('content-type') ?? '' };
      if (request.method !== 'GET') entry.body = await request.clone().text();
      calls.push(entry);
      if (url.hostname === 'cdn.discordapp.com') {
        return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });
      }
      if (url.hostname === 'places.googleapis.com') {
        return Response.json({ places: [{ displayName: { text: 'ローソン 渋谷道玄坂店' } }] });
      }
      if (url.hostname === 'api.coingecko.com') return Response.json({ litecoin: { jpy: 10000 } });
      assert.equal(url.hostname, 'discord.com');
      const path = url.pathname.replace(/^\/api\/v10/, '');
      if (path === `/guilds/${guildId}/channels` && request.method === 'POST') return Response.json({ id: ticketChannelId });
      if (/^\/channels\/\d+\/messages$/.test(path) && request.method === 'POST') return Response.json({ id: String(messageSeq++) });
      if (/^\/channels\/\d+\/messages\/\d+$/.test(path) && request.method === 'PATCH') return Response.json({ id: path.split('/').pop() });
      if (path.startsWith('/webhooks/')) return Response.json({ id: '1' });
      if (path === '/users/@me') return Response.json({ id: botId, username: 'cc-server' });
      return Response.json({ message: 'not mocked' }, { status: 404 });
    }
  });
  t.after(() => mf.dispose());

  async function interaction(payload) {
    const body = JSON.stringify({ id: '1', application_id: botId, token: 'itoken', guild_id: guildId, ...payload });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signMessage(null, Buffer.from(timestamp + body), privateKey).toString('hex');
    const response = await mf.dispatchFetch('https://worker.example/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
      body
    });
    return { status: response.status, body: await response.json() };
  }

  async function login() {
    const response = await mf.dispatchFetch('https://worker.example/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-password' })
    });
    const { token } = await response.json();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  return { mf, calls, interaction, login };
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for ' + label);
}

async function configure(env, reviewChannel = reviewChannelId) {
  const headers = await env.login();
  const response = await env.mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/amazon-vending`, {
    method: 'PUT', headers,
    body: JSON.stringify({ panel_title: 'Amazon自販機', panel_description: '', ltc_address: 'ltc1qtest', api_type: 'rainforest', api_key: 'k', review_channel_id: reviewChannel })
  });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await (await env.mf.dispatchFetch(`https://worker.example/api/guilds/${guildId}/amazon-vending`, { headers })).json();
  assert.equal(saved.review_channel_id, reviewChannel || null);
}

// 住所入力まで済んだ購入を再現し、購入チャンネルに番号とパネルが届くことを確認して注文IDを返す
async function purchase(env) {
  const db = await env.mf.getD1Database('DB');
  await db.prepare('INSERT INTO amazon_vending_sessions(id,guild_id,user_id,asin,product_json,created_at) VALUES(?,?,?,?,?,?)')
    .bind('sess1', guildId, buyerId, 'B000000001', JSON.stringify({ title: 'テスト商品', asin: 'B000000001', mainPriceJpy: 3000, imageUrl: null, variants: [] }), Date.now())
    .run();
  const result = await env.interaction({
    type: 5,
    member: { user: { id: buyerId, username: 'buyer' } },
    data: { custom_id: 'av:addr_modal:sess1', components: [{ type: 1, components: [{ type: 4, custom_id: 'address', value: 'ローソン 渋谷道玄坂店 東京都渋谷区道玄坂2-25-12' }] }] }
  });
  assert.equal(result.body.type, 4);
  assert.equal(result.body.data.embeds[0].title, 'お支払い情報');

  const ticketMessages = () => env.calls.filter(c => c.method === 'POST' && c.path === `/api/v10/channels/${ticketChannelId}/messages`);
  await waitFor(() => ticketMessages().length >= 2, 'ticket messages');
  const [orderMessage, panelMessage] = ticketMessages().map(c => JSON.parse(c.body));
  assert.ok(orderMessage.embeds[0].fields.some(f => f.name.includes('お問い合わせ番号')), 'numbers come first');
  const button = panelMessage.components[0].components[0];
  assert.match(button.custom_id, /^av:review:/);
  assert.equal(button.label, '実績を投稿する');
  const order = await db.prepare('SELECT * FROM amazon_vending_orders').first();
  assert.equal(order.user_id, buyerId);
  assert.equal(order.channel_id, ticketChannelId);
  assert.equal(order.product_title, 'テスト商品');
  return button.custom_id.split(':')[2];
}

function reviewSubmit(orderId, userId = buyerId, overrides = {}) {
  return {
    type: 5,
    channel_id: ticketChannelId,
    member: { user: { id: userId, username: 'buyer' } },
    message: { id: panelMessageId },
    data: {
      custom_id: `av:review_modal:${orderId}`,
      components: [
        { type: 18, id: 1, component: { type: 4, id: 2, custom_id: 'review', value: '受け取りまでスムーズでした！' } },
        { type: 18, id: 3, component: { type: 19, id: 4, custom_id: 'image', values: [attachmentId] } }
      ],
      resolved: { attachments: { [attachmentId]: {
        id: attachmentId, filename: 'photo.png', size: imageBytes.length, content_type: 'image/png',
        url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/photo.png'
      } } },
      ...overrides
    }
  };
}

test('purchase channel gets a review panel; buyer posts review + image to the achievement channel', async t => {
  const env = await runtime(t);
  await configure(env);
  const orderId = await purchase(env);

  // 購入者以外はモーダルを開けない
  const other = await env.interaction({ type: 3, member: { user: { id: otherId } }, data: { custom_id: `av:review:${orderId}` } });
  assert.equal(other.body.type, 4);
  assert.match(other.body.data.content, /購入者本人/);

  // 購入者には 感想(テキスト) + 画像1枚(ファイルアップロード) のモーダル
  const modal = await env.interaction({ type: 3, member: { user: { id: buyerId } }, data: { custom_id: `av:review:${orderId}` } });
  assert.equal(modal.body.type, 9);
  const [reviewLabel, imageLabel] = modal.body.data.components;
  assert.equal(reviewLabel.component.type, 4);
  assert.equal(imageLabel.component.type, 19);
  assert.equal(imageLabel.component.max_values, 1);

  const submit = await env.interaction(reviewSubmit(orderId));
  assert.equal(submit.body.type, 5);

  const reviewPosts = () => env.calls.filter(c => c.method === 'POST' && c.path === `/api/v10/channels/${reviewChannelId}/messages`);
  await waitFor(() => env.calls.some(c => c.method === 'PATCH' && c.path.startsWith('/api/v10/webhooks/')), 'interaction follow-up');
  assert.equal(reviewPosts().length, 1);
  const post = reviewPosts()[0];
  assert.match(post.contentType, /multipart\/form-data/);
  assert.match(post.body, /受け取りまでスムーズでした！/);
  assert.match(post.body, /テスト商品/);
  assert.match(post.body, /attachment:\/\/amazon-review\.png/);
  assert.match(post.body, /"allowed_mentions":\{"parse":\[\]\}/);
  assert.ok(env.calls.some(c => c.host === 'cdn.discordapp.com'), 'image is re-uploaded, not linked');

  const panelUpdate = env.calls.find(c => c.method === 'PATCH' && c.path === `/api/v10/channels/${ticketChannelId}/messages/${panelMessageId}`);
  assert.ok(panelUpdate, 'panel is marked as posted');
  assert.equal(JSON.parse(panelUpdate.body).components[0].components[0].disabled, true);
  const followUp = env.calls.filter(c => c.path.startsWith('/api/v10/webhooks/')).pop();
  assert.match(followUp.body, /実績を投稿しました/);

  // 二重投稿は不可
  const again = await env.interaction(reviewSubmit(orderId));
  assert.equal(again.body.type, 4);
  assert.match(again.body.data.content, /投稿済み/);
  assert.equal(reviewPosts().length, 1);
});

test('review is rejected for non-image files and when no achievement channel is configured', async t => {
  const env = await runtime(t);
  await configure(env);
  const orderId = await purchase(env);

  const pdf = reviewSubmit(orderId);
  pdf.data.resolved.attachments[attachmentId].content_type = 'application/pdf';
  const rejected = await env.interaction(pdf);
  assert.equal(rejected.body.type, 4);
  assert.match(rejected.body.data.content, /PNG/);

  await configure(env, '');
  const noChannel = await env.interaction({ type: 3, member: { user: { id: buyerId } }, data: { custom_id: `av:review:${orderId}` } });
  assert.equal(noChannel.body.type, 4);
  assert.match(noChannel.body.data.content, /実績投稿チャンネルが設定されていません/);
});

function payloadOf(call) {
  const match = call.body.match(/name="payload_json"\r\n(?:Content-Type:[^\r]*\r\n)?\r\n([\s\S]*?)\r\n--/);
  assert.ok(match, 'multipart payload_json');
  const payload = JSON.parse(match[1]);
  for (const embed of payload.embeds) delete embed.timestamp;
  return payload;
}

function reviewCommand(permissions, overrides = {}) {
  return {
    type: 2,
    channel_id: ticketChannelId,
    member: { user: { id: otherId }, permissions },
    data: {
      name: '実績',
      options: [
        { name: '購入者', type: 6, value: buyerId },
        { name: '商品', type: 3, value: 'テスト商品' },
        { name: '価格', type: 4, value: 3000 },
        { name: '感想', type: 3, value: '受け取りまでスムーズでした！' },
        { name: '画像', type: 11, value: attachmentId }
      ],
      resolved: { attachments: { [attachmentId]: {
        id: attachmentId, filename: 'photo.png', size: imageBytes.length, content_type: 'image/png',
        url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/photo.png'
      } } },
      ...overrides
    }
  };
}

test('/実績: only administrators can post manually, with exactly the same look as the panel', async t => {
  const env = await runtime(t);
  await configure(env);
  const reviewPosts = () => env.calls.filter(c => c.method === 'POST' && c.path === `/api/v10/channels/${reviewChannelId}/messages`);

  // 管理者権限なし (メッセージ管理など他の権限だけ) は拒否
  const denied = await env.interaction(reviewCommand(String(8192n | 2048n)));
  assert.equal(denied.body.type, 4);
  assert.match(denied.body.data.content, /管理者権限/);
  assert.equal(reviewPosts().length, 0);

  // 管理者は投稿できる
  const ok = await env.interaction(reviewCommand(String(8n | 2048n)));
  assert.equal(ok.body.type, 5);
  await waitFor(() => reviewPosts().length === 1 && env.calls.some(c => c.path.startsWith('/api/v10/webhooks/')), 'manual post');
  assert.match(env.calls.filter(c => c.path.startsWith('/api/v10/webhooks/')).pop().body, /実績を投稿しました/);
  const manual = payloadOf(reviewPosts()[0]);

  // 同じ内容をパネルから投稿したものと完全に一致する
  const orderId = await purchase(env);
  await env.interaction(reviewSubmit(orderId));
  await waitFor(() => reviewPosts().length === 2, 'panel post');
  assert.deepEqual(manual, payloadOf(reviewPosts()[1]));
  assert.equal(manual.embeds[0].title, '📦 実績');
});

test('/実績 is registered as an administrator-only command', async t => {
  const env = await runtime(t);
  // Cron のコマンド同期で Discord に登録される定義を確認する
  const worker = await env.mf.getWorker();
  await worker.scheduled({ cron: '* * * * *' });
  await waitFor(() => env.calls.some(c => c.method === 'PUT' && c.path === `/api/v10/applications/${botId}/commands`), 'command sync');
  const commands = JSON.parse(env.calls.find(c => c.method === 'PUT' && c.path.endsWith('/commands')).body);
  const command = commands.find(c => c.name === '実績');
  assert.ok(command, '/実績 is registered');
  assert.equal(command.default_member_permissions, '8');
  assert.equal(command.dm_permission, false);
  assert.deepEqual(command.options.map(o => o.name), ['購入者', '商品', '価格', '感想', '画像']);
});
