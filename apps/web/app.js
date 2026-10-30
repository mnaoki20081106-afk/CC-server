// API base injected by CI; fallback for local dev
const API_BASE = window.CC_SERVER_API || 'https://cc-server.workers.dev';

let token = null;
let guilds = [];
let currentGuild = null;
let currentMeta = null; // { channels, roles }
let currentConfig = null;

// ── storage ──────────────────────────────────────────────────────────────────
function loadToken() {
  try { return sessionStorage.getItem('cc_token'); } catch { return null; }
}
function saveToken(t) {
  try { sessionStorage.setItem('cc_token', t); } catch {}
}
function clearToken() {
  try { sessionStorage.removeItem('cc_token'); } catch {}
}

// ── fetch helpers ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── views ─────────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}
function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
}

// ── message helpers ───────────────────────────────────────────────────────────
function showMsg(el, text, isOk) {
  el.textContent = text;
  el.className = `msg ${isOk ? 'ok' : 'err'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── login ─────────────────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('password-input').value;
  const errEl = document.getElementById('login-error');
  try {
    const data = await api('POST', '/api/login', { password: pw });
    token = data.token;
    saveToken(token);
    errEl.classList.add('hidden');
    await enterApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  token = null;
  clearToken();
  currentGuild = null;
  currentMeta = null;
  showLogin();
});

// ── init ──────────────────────────────────────────────────────────────────────
async function init() {
  const saved = loadToken();
  if (saved) {
    token = saved;
    try {
      await enterApp();
      return;
    } catch {
      token = null;
      clearToken();
    }
  }
  showLogin();
}

async function enterApp() {
  guilds = await api('GET', '/api/guilds');
  renderGuildList();
  showApp();
}

// ── guild list ────────────────────────────────────────────────────────────────
function renderGuildList() {
  const el = document.getElementById('guild-list');
  el.innerHTML = '';
  for (const g of guilds) {
    const item = document.createElement('div');
    item.className = 'guild-item' + (currentGuild?.id === g.id ? ' active' : '');
    item.textContent = g.name;
    item.onclick = () => selectGuild(g);
    el.appendChild(item);
  }
}

async function selectGuild(g) {
  currentGuild = g;
  document.querySelectorAll('.guild-item').forEach(el => el.classList.toggle('active', el.textContent === g.name));
  document.getElementById('no-guild').classList.add('hidden');
  document.getElementById('guild-panel').classList.remove('hidden');

  // fetch meta + config in parallel
  const [meta, cfg] = await Promise.all([
    api('GET', `/api/guilds/${g.id}/meta`),
    api('GET', `/api/guilds/${g.id}/config`),
  ]);
  currentMeta = meta;
  currentConfig = cfg;

  populateSelects();
  populateConfig();
  switchTab('config');
}

// ── selects ───────────────────────────────────────────────────────────────────
function populateSelects() {
  const { channels, roles } = currentMeta;
  const roleSelects = [
    ['sel-admin-role', 'admin_role_id'],
    ['sel-mod-role', 'mod_role_id'],
    ['sel-verified-role', 'verified_role_id'],
  ];
  const chSelects = [
    ['sel-log-ch', 'log_channel_id'],
    ['sel-verify-ch', 'verify_channel_id'],
    ['sel-welcome-ch', 'welcome_channel_id'],
    ['sel-leave-ch', 'leave_channel_id'],
  ];

  for (const [id] of roleSelects) {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">なし</option>';
    for (const r of roles) {
      const opt = document.createElement('option');
      opt.value = r.id; opt.textContent = r.name;
      sel.appendChild(opt);
    }
  }
  for (const [id] of chSelects) {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">なし</option>';
    for (const c of channels) {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = '#' + c.name;
      sel.appendChild(opt);
    }
  }

  // populate AV channel select
  const avCh = document.getElementById('av-post-ch');
  avCh.innerHTML = '<option value="">チャンネルを選択</option>';
  for (const c of channels) {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = '#' + c.name;
    avCh.appendChild(opt);
  }
}

// ── config tab ────────────────────────────────────────────────────────────────
function populateConfig() {
  const form = document.getElementById('config-form');
  const cfg = currentConfig;
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = cfg[el.name];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
}

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') body[el.name] = el.checked ? 1 : 0;
    else body[el.name] = el.value || null;
  }
  const msg = document.getElementById('config-msg');
  try {
    await api('PUT', `/api/guilds/${currentGuild.id}/config`, body);
    showMsg(msg, '保存しました', true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

// ── tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');

  if (tab === 'panels') loadPanels();
  if (tab === 'amazon') loadAvConfig();
}

// ── panels tab ────────────────────────────────────────────────────────────────
let panels = [];

async function loadPanels() {
  panels = await api('GET', `/api/guilds/${currentGuild.id}/panels`);
  renderPanels();
}

function renderPanels() {
  const el = document.getElementById('panel-list');
  el.innerHTML = '';
  for (const p of panels) {
    const card = document.createElement('div');
    card.className = 'panel-card';
    card.dataset.panelId = p.id;
    card.innerHTML = `
      <h3>${escHtml(p.title)}</h3>
      ${p.description ? `<p class="panel-desc">${escHtml(p.description)}</p>` : ''}
      <div class="btn-list" id="btnlist-${p.id}"></div>
      <div class="add-btn-form">
        <input type="text" placeholder="ラベル" class="btn-label">
        <select class="btn-style">
          <option value="Primary">青</option>
          <option value="Secondary">グレー</option>
          <option value="Success">緑</option>
          <option value="Danger">赤</option>
        </select>
        <select class="btn-action-type">
          <option value="toggle_role">ロール付与/剥奪</option>
          <option value="show_text">テキスト表示</option>
        </select>
        <input type="text" placeholder="ロールID or テキスト" class="btn-action-val">
        <button class="add-btn-btn" data-panel-id="${p.id}">ボタン追加</button>
      </div>
      <div class="post-row">
        <select class="panel-ch-sel">
          <option value="">チャンネルを選択</option>
          ${(currentMeta?.channels ?? []).map(c => `<option value="${c.id}">#${escHtml(c.name)}</option>`).join('')}
        </select>
        <button class="panel-post-btn" data-panel-id="${p.id}">投稿</button>
      </div>
    `;
    el.appendChild(card);
    loadPanelButtons(p.id);
  }

  document.querySelectorAll('.add-btn-btn').forEach(btn => {
    btn.addEventListener('click', () => addButton(parseInt(btn.dataset.panelId)));
  });
  document.querySelectorAll('.panel-post-btn').forEach(btn => {
    btn.addEventListener('click', () => postPanel(parseInt(btn.dataset.panelId)));
  });
}

async function loadPanelButtons(panelId) {
  const buttons = await api('GET', `/api/guilds/${currentGuild.id}/panels/${panelId}/buttons`);
  const el = document.getElementById(`btnlist-${panelId}`);
  if (!el) return;
  el.innerHTML = '';
  for (const b of buttons) {
    const chip = document.createElement('span');
    chip.className = 'btn-chip';
    chip.innerHTML = `${escHtml(b.label)} <button data-btn-id="${b.id}" data-panel-id="${panelId}">×</button>`;
    chip.querySelector('button').addEventListener('click', async (e) => {
      const btnId = e.currentTarget.dataset.btnId;
      const pid = e.currentTarget.dataset.panelId;
      await api('DELETE', `/api/guilds/${currentGuild.id}/panels/${pid}/buttons/${btnId}`);
      loadPanelButtons(parseInt(pid));
    });
    el.appendChild(chip);
  }
}

async function addButton(panelId) {
  const card = document.querySelector(`.panel-card[data-panel-id="${panelId}"]`);
  const label = card.querySelector('.btn-label').value.trim();
  const style = card.querySelector('.btn-style').value;
  const actionType = card.querySelector('.btn-action-type').value;
  const actionValue = card.querySelector('.btn-action-val').value.trim();
  if (!label || !actionValue) return alert('ラベルとアクション値を入力してください');
  await api('POST', `/api/guilds/${currentGuild.id}/panels/${panelId}/buttons`, { label, style, action_type: actionType, action_value: actionValue });
  card.querySelector('.btn-label').value = '';
  card.querySelector('.btn-action-val').value = '';
  loadPanelButtons(panelId);
}

async function postPanel(panelId) {
  const card = document.querySelector(`.panel-card[data-panel-id="${panelId}"]`);
  const channelId = card.querySelector('.panel-ch-sel').value;
  if (!channelId) return alert('チャンネルを選択してください');
  try {
    await api('POST', `/api/guilds/${currentGuild.id}/panels/${panelId}/post`, { channel_id: channelId });
    alert('パネルを投稿しました');
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('create-panel-btn').addEventListener('click', async () => {
  const title = document.getElementById('panel-title').value.trim();
  const desc = document.getElementById('panel-desc').value.trim();
  if (!title) return alert('タイトルを入力してください');
  await api('POST', `/api/guilds/${currentGuild.id}/panels`, { title, description: desc || null });
  document.getElementById('panel-title').value = '';
  document.getElementById('panel-desc').value = '';
  loadPanels();
});

// ── amazon tab ────────────────────────────────────────────────────────────────
async function loadAvConfig() {
  const cfg = await api('GET', `/api/guilds/${currentGuild.id}/amazon-vending`);
  const form = document.getElementById('av-config-form');
  for (const el of form.elements) {
    if (!el.name) continue;
    el.value = cfg[el.name] ?? '';
  }
}

document.getElementById('av-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {};
  for (const el of form.elements) {
    if (el.name) body[el.name] = el.value;
  }
  const msg = document.getElementById('av-config-msg');
  try {
    await api('PUT', `/api/guilds/${currentGuild.id}/amazon-vending`, body);
    showMsg(msg, '保存しました', true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

document.getElementById('av-post-btn').addEventListener('click', async () => {
  const channelId = document.getElementById('av-post-ch').value;
  const msg = document.getElementById('av-post-msg');
  if (!channelId) { showMsg(msg, 'チャンネルを選択してください', false); return; }
  try {
    await api('POST', `/api/guilds/${currentGuild.id}/amazon-vending/panel`, { channel_id: channelId });
    showMsg(msg, 'パネルを投稿しました', true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

// ── util ──────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// start
init();
