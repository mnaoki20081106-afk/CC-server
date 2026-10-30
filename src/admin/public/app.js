const API = '';
let token = localStorage.getItem('admin_token') || '';
let currentGuildId = '';
let guildMeta = null; // { channels, roles }

// ── Utilities ──────────────────────────────────────────────────────────────

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'x-admin-token': token } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

function toast(msg, type = 'success') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

function channelOptions(selected = '') {
  if (!guildMeta) return '';
  return guildMeta.channels
    .filter(c => c.type === 0 || c.type === 5)
    .map(c => `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>#${c.name}</option>`)
    .join('');
}

function roleOptions(selected = '') {
  if (!guildMeta) return '';
  return guildMeta.roles
    .map(r => `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${r.name}</option>`)
    .join('');
}

// ── Auth ───────────────────────────────────────────────────────────────────

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError');
  try {
    const data = await req('POST', '/admin/api/login', { password: pw });
    token = data.token;
    localStorage.setItem('admin_token', token);
    err.textContent = '';
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  token = '';
  localStorage.removeItem('admin_token');
  document.getElementById('appView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
});

// ── Tab nav ────────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-tab]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Guild select ───────────────────────────────────────────────────────────

document.getElementById('guildSelect').addEventListener('change', async e => {
  currentGuildId = e.target.value;
  if (!currentGuildId) return;
  try {
    guildMeta = await req('GET', `/admin/api/guilds/${currentGuildId}/meta`);
    renderConfig();
    renderPanels();
    renderAmazon();
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// ── App init ───────────────────────────────────────────────────────────────

async function showApp() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  try {
    const guilds = await req('GET', '/admin/api/guilds');
    const sel = document.getElementById('guildSelect');
    sel.innerHTML = '<option value="">サーバーを選択</option>' +
      guilds.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

if (token) {
  showApp().catch(() => {
    token = '';
    localStorage.removeItem('admin_token');
  });
}

// ── Config tab ─────────────────────────────────────────────────────────────

async function renderConfig() {
  const wrap = document.getElementById('configContent');
  wrap.innerHTML = '<p class="empty">読み込み中...</p>';
  const cfg = await req('GET', `/admin/api/guilds/${currentGuildId}/config`);

  wrap.innerHTML = `
  <form id="configForm" class="card">
    <h2>基本設定</h2>
    <div class="grid-2">
      <label>管理者ロール
        <select name="admin_role_id"><option value="">なし</option>${roleOptions(cfg.admin_role_id)}</select>
      </label>
      <label>モデレーターロール
        <select name="mod_role_id"><option value="">なし</option>${roleOptions(cfg.mod_role_id)}</select>
      </label>
      <label>ログチャンネル
        <select name="log_channel_id"><option value="">なし</option>${channelOptions(cfg.log_channel_id)}</select>
      </label>
      <label>認証済みロール
        <select name="verified_role_id"><option value="">なし</option>${roleOptions(cfg.verified_role_id)}</select>
      </label>
      <label>認証チャンネル
        <select name="verify_channel_id"><option value="">なし</option>${channelOptions(cfg.verify_channel_id)}</select>
      </label>
      <label>チケットカテゴリID
        <input name="ticket_category_id" value="${cfg.ticket_category_id || ''}" placeholder="カテゴリID">
      </label>
      <label>チケットログチャンネル
        <select name="ticket_log_channel_id"><option value="">なし</option>${channelOptions(cfg.ticket_log_channel_id)}</select>
      </label>
    </div>
    <h2>ウェルカム / 退出</h2>
    <div class="grid-2">
      <label>ウェルカムチャンネル
        <select name="welcome_channel_id"><option value="">なし</option>${channelOptions(cfg.welcome_channel_id)}</select>
      </label>
      <label>ウェルカムメッセージ
        <input name="welcome_message" value="${(cfg.welcome_message||'').replace(/"/g,'&quot;')}" placeholder="{user} さん、ようこそ！">
      </label>
      <label>退出チャンネル
        <select name="leave_channel_id"><option value="">なし</option>${channelOptions(cfg.leave_channel_id)}</select>
      </label>
      <label>退出メッセージ
        <input name="leave_message" value="${(cfg.leave_message||'').replace(/"/g,'&quot;')}" placeholder="{user} さんが退出しました。">
      </label>
    </div>
    <h2>セキュリティ</h2>
    <div class="grid-2">
      <label>スパム対策
        <select name="anti_spam_enabled">
          <option value="0"${!cfg.anti_spam_enabled?' selected':''}>無効</option>
          <option value="1"${cfg.anti_spam_enabled?' selected':''}>有効</option>
        </select>
      </label>
      <label>スパム閾値 (${cfg.anti_spam_window_ms||7000}ms中に何回)
        <input type="number" name="anti_spam_threshold" value="${cfg.anti_spam_threshold||5}" min="2" max="50">
      </label>
      <label>リンク禁止
        <select name="anti_link_enabled">
          <option value="0"${!cfg.anti_link_enabled?' selected':''}>無効</option>
          <option value="1"${cfg.anti_link_enabled?' selected':''}>有効</option>
        </select>
      </label>
      <label>レイド対策
        <select name="raid_protection_enabled">
          <option value="0"${!cfg.raid_protection_enabled?' selected':''}>無効</option>
          <option value="1"${cfg.raid_protection_enabled?' selected':''}>有効</option>
        </select>
      </label>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">保存</button>
    </div>
    <div id="configState" class="inline-state"></div>
  </form>`;

  document.getElementById('configForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const fields = {};
    for (const [k, v] of fd) fields[k] = v === '' ? null : v;
    try {
      await req('PUT', `/admin/api/guilds/${currentGuildId}/config`, fields);
      document.getElementById('configState').textContent = '保存しました。';
      document.getElementById('configState').className = 'inline-state ok';
    } catch (ex) {
      document.getElementById('configState').textContent = ex.message;
      document.getElementById('configState').className = 'inline-state err';
    }
  });
}

// ── Panels tab ─────────────────────────────────────────────────────────────

let panelList = [];
let selectedPanelId = null;

async function renderPanels() {
  const wrap = document.getElementById('panelsContent');
  panelList = await req('GET', `/admin/api/guilds/${currentGuildId}/panels`);

  wrap.innerHTML = `
  <div class="card">
    <h2>パネルを作成</h2>
    <form id="createPanelForm" class="grid-2">
      <label>タイトル <input name="title" placeholder="パネルタイトル" required></label>
      <label>説明文 <input name="description" placeholder="説明（任意）"></label>
      <div class="full form-actions"><button type="submit" class="btn btn-primary">作成</button></div>
    </form>
  </div>
  <div class="card">
    <h2>パネル一覧</h2>
    ${panelList.length === 0 ? '<p class="empty">まだパネルはありません。</p>' : `
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>タイトル</th><th>投稿先</th><th>操作</th></tr></thead>
        <tbody>${panelList.map(p => `
          <tr>
            <td>#${p.id}</td>
            <td>${p.title}</td>
            <td>${p.channel_id ? `<#${p.channel_id}>` : '未投稿'}</td>
            <td class="panel-row-actions">
              <button class="btn btn-primary" onclick="openPanelEditor(${p.id})">編集/投稿</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`}
  </div>
  <div id="panelEditor" class="card hidden">
    <h2 id="panelEditorTitle">パネル編集</h2>
    <div id="panelEditorBody"></div>
  </div>`;

  document.getElementById('createPanelForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await req('POST', `/admin/api/guilds/${currentGuildId}/panels`, {
        title: fd.get('title'), description: fd.get('description') || null
      });
      toast('パネルを作成しました。');
      renderPanels();
    } catch (ex) { toast(ex.message, 'error'); }
  });
}

window.openPanelEditor = async function(panelId) {
  selectedPanelId = panelId;
  const panel = panelList.find(p => p.id === panelId);
  const editor = document.getElementById('panelEditor');
  const body = document.getElementById('panelEditorBody');
  document.getElementById('panelEditorTitle').textContent = `パネル #${panelId} — ${panel.title}`;
  editor.classList.remove('hidden');

  const buttons = await req('GET', `/admin/api/guilds/${currentGuildId}/panels/${panelId}/buttons`);

  body.innerHTML = `
  <h2 style="font-size:13px;color:var(--muted);margin-bottom:4px">ボタン一覧</h2>
  ${buttons.length === 0 ? '<p class="empty">ボタンはまだありません。</p>' : `
  <div class="table-wrap">
    <table>
      <thead><tr><th>ラベル</th><th>スタイル</th><th>アクション</th><th>値</th><th></th></tr></thead>
      <tbody>${buttons.map(b => `
        <tr>
          <td>${b.label}</td>
          <td>${b.style}</td>
          <td>${b.action_type}</td>
          <td>${b.action_value}</td>
          <td><button class="btn btn-danger" onclick="deleteButton(${b.id})">削除</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`}
  <form id="addBtnForm" class="grid-2" style="margin-top:12px">
    <label>ラベル <input name="label" placeholder="ボタンのラベル" required></label>
    <label>スタイル
      <select name="style">
        <option value="Primary">Primary (青)</option>
        <option value="Secondary">Secondary (灰)</option>
        <option value="Success">Success (緑)</option>
        <option value="Danger">Danger (赤)</option>
      </select>
    </label>
    <label>アクション
      <select name="action_type">
        <option value="toggle_role">ロール付与/解除</option>
        <option value="show_text">テキスト表示</option>
      </select>
    </label>
    <label>値 (ロールID / テキスト)
      <input name="action_value" placeholder="ロールID or テキスト" required>
    </label>
    <label>絵文字 <input name="emoji" placeholder="任意"></label>
    <div class="full form-actions"><button type="submit" class="btn btn-primary">ボタンを追加</button></div>
  </form>
  <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
    <h2 style="font-size:13px;color:var(--muted);margin-bottom:8px">チャンネルに投稿</h2>
    <form id="postPanelForm" class="grid-2">
      <label>投稿先チャンネル
        <select name="channel_id" required><option value="">選択</option>${channelOptions()}</select>
      </label>
      <div class="full form-actions"><button type="submit" class="btn btn-primary">投稿</button></div>
    </form>
  </div>`;

  document.getElementById('addBtnForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await req('POST', `/admin/api/guilds/${currentGuildId}/panels/${panelId}/buttons`, {
        label: fd.get('label'), style: fd.get('style'),
        action_type: fd.get('action_type'), action_value: fd.get('action_value'),
        emoji: fd.get('emoji') || null
      });
      toast('ボタンを追加しました。');
      openPanelEditor(panelId);
    } catch (ex) { toast(ex.message, 'error'); }
  });

  document.getElementById('postPanelForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await req('POST', `/admin/api/guilds/${currentGuildId}/panels/${panelId}/post`, {
        channel_id: fd.get('channel_id')
      });
      toast('パネルを投稿しました。');
      renderPanels();
    } catch (ex) { toast(ex.message, 'error'); }
  });
};

window.deleteButton = async function(btnId) {
  if (!confirm('このボタンを削除しますか？')) return;
  try {
    await req('DELETE', `/admin/api/guilds/${currentGuildId}/panels/${selectedPanelId}/buttons/${btnId}`);
    toast('削除しました。');
    openPanelEditor(selectedPanelId);
  } catch (ex) { toast(ex.message, 'error'); }
};

// ── Amazon自販機 tab ─────────────────────────────────────────────────────────

async function renderAmazon() {
  const wrap = document.getElementById('amazonContent');
  wrap.innerHTML = '<p class="empty">読み込み中...</p>';
  const cfg = await req('GET', `/admin/api/guilds/${currentGuildId}/amazon-vending`);

  wrap.innerHTML = `
  <div class="card">
    <h2>設定</h2>
    <p>APIキーとLTCアドレスを設定し、「購入する」ボタン付きのパネルをチャンネルに投稿します。</p>
    <form id="avConfigForm" class="grid-2">
      <label>パネルタイトル
        <input name="panel_title" value="${(cfg.panel_title||'').replace(/"/g,'&quot;')}" placeholder="Amazon自販機" required>
      </label>
      <label>LTCアドレス
        <input name="ltc_address" value="${(cfg.ltc_address||'').replace(/"/g,'&quot;')}" placeholder="Lxxxxxxxxxxxxxxxx">
      </label>
      <label class="full">パネル説明文
        <textarea name="panel_description">${cfg.panel_description||''}</textarea>
      </label>
      <label>Amazon API
        <select name="api_type">
          <option value="rainforest"${cfg.api_type==='rainforest'?' selected':''}>Rainforest API</option>
          <option value="keepa"${cfg.api_type==='keepa'?' selected':''}>Keepa API</option>
          <option value="canopy"${cfg.api_type==='canopy'?' selected':''}>Canopy API</option>
        </select>
      </label>
      <label>APIキー
        <input type="password" name="api_key" value="${(cfg.api_key||'').replace(/"/g,'&quot;')}" placeholder="APIキー" autocomplete="off">
      </label>
      <div class="full form-actions">
        <button type="submit" class="btn btn-primary">設定を保存</button>
      </div>
      <div id="avConfigState" class="inline-state full"></div>
    </form>
  </div>
  <div class="card">
    <h2>パネルを投稿</h2>
    <p>設定したタイトル・説明文で「購入する」ボタン付きパネルをDiscordに投稿します。</p>
    <form id="avPostForm" class="grid-2">
      <label>投稿先チャンネル
        <select name="channel_id" required><option value="">選択</option>${channelOptions()}</select>
      </label>
      <div class="full form-actions">
        <button type="submit" class="btn btn-primary">パネルを投稿</button>
      </div>
    </form>
  </div>`;

  document.getElementById('avConfigForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const state = document.getElementById('avConfigState');
    try {
      await req('PUT', `/admin/api/guilds/${currentGuildId}/amazon-vending`, Object.fromEntries(fd));
      state.textContent = '保存しました。';
      state.className = 'inline-state ok';
    } catch (ex) {
      state.textContent = ex.message;
      state.className = 'inline-state err';
    }
  });

  document.getElementById('avPostForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await req('POST', `/admin/api/guilds/${currentGuildId}/amazon-vending/panel`, { channel_id: fd.get('channel_id') });
      toast('パネルを投稿しました。');
    } catch (ex) { toast(ex.message, 'error'); }
  });
}
