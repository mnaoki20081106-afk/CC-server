import { useEffect, useMemo, useState } from "react";
import { api, clearSession, currentSession, login } from "./api";

type Guild = { id: string; name: string; icon: string | null };
type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Role = { id: string; name: string; color: number };
type Meta = { id: string; name: string; icon: string | null; channels: Channel[]; roles: Role[] };

type GuildConfig = {
  admin_role_id: string | null;
  mod_role_id: string | null;
  log_channel_id: string | null;
  verified_role_id: string | null;
  verify_channel_id: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  leave_channel_id: string | null;
  leave_message: string | null;
  anti_spam_enabled: number;
  anti_spam_threshold: number;
  anti_spam_window_ms: number;
  anti_link_enabled: number;
  anti_link_whitelist: string;
  raid_protection_enabled: number;
  raid_join_threshold: number;
  raid_window_ms: number;
  raid_action: string;
};

type Panel = { id: number; title: string; description: string | null; message_id: string | null; channel_id: string | null };
type PanelButton = { id: number; label: string; style: string; emoji: string | null; action_type: string; action_value: string };

type AvConfig = {
  panel_title: string;
  panel_description: string | null;
  ltc_address: string | null;
  api_type: string;
  api_key: string | null;
};

type ServiceStatus = {
  discordReady: boolean;
  discordUser?: string | null;
  discordError?: string | null;
  guildCount?: number | null;
  inviteUrl: string;
};

const STYLE_LABEL: Record<string, string> = { Primary: "青", Secondary: "グレー", Success: "緑", Danger: "赤" };

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(currentSession()));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [config, setConfig] = useState<GuildConfig | null>(null);
  const [activeTab, setActiveTab] = useState<"config" | "panels" | "amazon">("config");

  const [panels, setPanels] = useState<Panel[]>([]);
  const [panelButtons, setPanelButtons] = useState<Record<number, PanelButton[]>>({});
  const [avConfig, setAvConfig] = useState<AvConfig | null>(null);

  const selectedGuild = useMemo(() => guilds.find(g => g.id === selectedId) ?? null, [guilds, selectedId]);

  function flash(message: string) {
    setNotice(message);
    setError(null);
    window.setTimeout(() => setNotice(null), 3500);
  }

  function fail(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(message);
    setNotice(null);
  }

  useEffect(() => {
    if (authenticated) void loadBase();
  }, [authenticated]);

  async function loadBase() {
    setBusy(true);
    setError(null);
    try {
      const service = await api<ServiceStatus>("/api/status");
      setStatus(service);
      const serverList = await api<Guild[]>("/api/guilds");
      setGuilds(serverList);
      if (!selectedId && serverList.length > 0) await selectGuild(serverList[0].id);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function selectGuild(guildId: string) {
    setBusy(true);
    setError(null);
    try {
      const [m, c] = await Promise.all([
        api<Meta>(`/api/guilds/${guildId}/meta`),
        api<GuildConfig>(`/api/guilds/${guildId}/config`)
      ]);
      setMeta(m);
      setConfig(c);
      setSelectedId(guildId);
      setActiveTab("config");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(patch: Partial<GuildConfig>) {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${selectedId}/config`, { method: "PUT", body: JSON.stringify(patch) });
      setConfig(prev => (prev ? { ...prev, ...patch } : prev));
      flash("保存しました");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function loadPanels() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const list = await api<Panel[]>(`/api/guilds/${selectedId}/panels`);
      setPanels(list);
      const entries = await Promise.all(
        list.map(async p => [p.id, await api<PanelButton[]>(`/api/guilds/${selectedId}/panels/${p.id}/buttons`)] as const)
      );
      setPanelButtons(Object.fromEntries(entries));
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function createPanel(title: string, description: string) {
    if (!selectedId || !title.trim()) return;
    try {
      await api(`/api/guilds/${selectedId}/panels`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null })
      });
      await loadPanels();
      flash("パネルを作成しました");
    } catch (reason) {
      fail(reason);
    }
  }

  async function addButton(panelId: number, data: { label: string; style: string; action_type: string; action_value: string }) {
    if (!selectedId) return;
    try {
      await api(`/api/guilds/${selectedId}/panels/${panelId}/buttons`, { method: "POST", body: JSON.stringify(data) });
      const buttons = await api<PanelButton[]>(`/api/guilds/${selectedId}/panels/${panelId}/buttons`);
      setPanelButtons(prev => ({ ...prev, [panelId]: buttons }));
    } catch (reason) {
      fail(reason);
    }
  }

  async function deleteButton(panelId: number, buttonId: number) {
    if (!selectedId) return;
    try {
      await api(`/api/guilds/${selectedId}/panels/${panelId}/buttons/${buttonId}`, { method: "DELETE" });
      setPanelButtons(prev => ({ ...prev, [panelId]: (prev[panelId] ?? []).filter(b => b.id !== buttonId) }));
    } catch (reason) {
      fail(reason);
    }
  }

  async function postPanel(panelId: number, channelId: string) {
    if (!selectedId || !channelId) return;
    try {
      await api(`/api/guilds/${selectedId}/panels/${panelId}/post`, { method: "POST", body: JSON.stringify({ channel_id: channelId }) });
      flash("パネルを投稿しました");
    } catch (reason) {
      fail(reason);
    }
  }

  async function loadAvConfig() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const cfg = await api<AvConfig>(`/api/guilds/${selectedId}/amazon-vending`);
      setAvConfig(cfg);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function saveAvConfig(patch: AvConfig) {
    if (!selectedId) return;
    try {
      await api(`/api/guilds/${selectedId}/amazon-vending`, { method: "PUT", body: JSON.stringify(patch) });
      setAvConfig(patch);
      flash("設定を保存しました");
    } catch (reason) {
      fail(reason);
    }
  }

  async function postAvPanel(channelId: string) {
    if (!selectedId || !channelId) return;
    try {
      await api(`/api/guilds/${selectedId}/amazon-vending/panel`, { method: "POST", body: JSON.stringify({ channel_id: channelId }) });
      flash("パネルを投稿しました");
    } catch (reason) {
      fail(reason);
    }
  }

  function logout() {
    clearSession();
    setAuthenticated(false);
    setGuilds([]);
    setSelectedId(null);
    setMeta(null);
    setConfig(null);
  }

  useEffect(() => {
    if (activeTab === "panels" && selectedId) void loadPanels();
    if (activeTab === "amazon" && selectedId) void loadAvConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedId]);

  if (!authenticated) {
    return (
      <main className="center-screen">
        <section className="login-card">
          <div className="logo-mark">C</div>
          <span className="eyebrow">CC-Server</span>
          <h1>管理パスワードでアクセス</h1>
          <p>BOTが参加しているDiscordサーバーだけが管理画面に表示されます。</p>
          <form
            onSubmit={async event => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await login(password);
                setPassword("");
                setAuthenticated(true);
              } catch (reason) {
                fail(reason);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="管理パスワード"
              autoComplete="current-password"
              required
            />
            <button className="primary big" type="submit" disabled={busy}>
              {busy ? "確認中..." : "管理画面へ"}
            </button>
          </form>
          {error && <div className="alert error">{error}</div>}
        </section>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-mark small">C</div>
          <div>
            <strong>CC-Server</strong>
            <small>Server Manager</small>
          </div>
        </div>

        <div className="server-list">
          <span className="side-label">SERVERS</span>
          {guilds.length === 0 && (
            <p className="muted" style={{ padding: "0 10px" }}>
              Botがまだどのサーバーにも参加していません。
            </p>
          )}
          {guilds.map(guild => (
            <button
              key={guild.id}
              className={`server-button ${selectedId === guild.id ? "active" : ""}`}
              onClick={() => void selectGuild(guild.id)}
            >
              {guild.icon ? (
                <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=80`} alt="" />
              ) : (
                <span className="server-fallback">{guild.name.slice(0, 2).toUpperCase()}</span>
              )}
              <span className="server-copy">
                <strong>{guild.name}</strong>
                <small>BOT導入済み</small>
              </span>
              <span className="dot online" />
            </button>
          ))}
        </div>

        <div className="account">
          <div className="avatar">C</div>
          <div>
            <strong>管理者</strong>
            <small>共有パスワード</small>
          </div>
          <button className="icon-button" onClick={logout} title="ログアウト">
            ↪
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">CONTROL PANEL</span>
            <h1>{selectedGuild?.name ?? "サーバーを選択"}</h1>
          </div>
          <div className="status-row">
            {status?.inviteUrl && (
              <a className="primary" href={status.inviteUrl} target="_blank" rel="noreferrer">
                BOTをサーバーへ追加
              </a>
            )}
            <span className={`status-pill ${status?.discordReady ? "good" : "bad"}`} title={status?.discordError ?? undefined}>
              <i /> BOT {status?.discordReady ? "Online" : "Offline"}
              {status?.discordReady && typeof status.guildCount === "number" ? ` · ${status.guildCount} server${status.guildCount === 1 ? "" : "s"}` : ""}
            </span>
            <span className="status-pill good">
              <i /> API Serverless
            </span>
          </div>
        </header>

        {notice && <div className="alert success">{notice}</div>}
        {error && <div className="alert error">{error}</div>}
        {busy && (
          <div className="progress">
            <span />
          </div>
        )}

        {!selectedGuild && (
          <section className="empty-state card">
            <h2>管理するサーバーを選んでください</h2>
            <p>BOTを追加すると、参加済みサーバーがここに自動表示されます。</p>
            {status?.discordError && <div className="alert error">Discord API: {status.discordError}</div>}
            <button className="primary" onClick={() => void loadBase()} disabled={busy}>
              サーバー一覧を再読み込み
            </button>
          </section>
        )}

        {selectedGuild && meta && config && (
          <>
            <nav className="page-tabs" role="tablist" aria-label="管理機能">
              <button type="button" role="tab" aria-selected={activeTab === "config"} className={activeTab === "config" ? "active" : ""} onClick={() => setActiveTab("config")}>
                サーバー設定
              </button>
              <button type="button" role="tab" aria-selected={activeTab === "panels"} className={activeTab === "panels" ? "active" : ""} onClick={() => setActiveTab("panels")}>
                パネル
              </button>
              <button type="button" role="tab" aria-selected={activeTab === "amazon"} className={activeTab === "amazon" ? "active" : ""} onClick={() => setActiveTab("amazon")}>
                Amazon自販機
              </button>
            </nav>

            {activeTab === "config" && <ConfigTab meta={meta} config={config} onSave={saveConfig} />}
            {activeTab === "panels" && (
              <PanelsTab
                meta={meta}
                panels={panels}
                panelButtons={panelButtons}
                onCreatePanel={createPanel}
                onAddButton={addButton}
                onDeleteButton={deleteButton}
                onPostPanel={postPanel}
              />
            )}
            {activeTab === "amazon" && avConfig && <AmazonTab meta={meta} avConfig={avConfig} onSave={saveAvConfig} onPost={postAvPanel} />}
          </>
        )}
      </main>
    </div>
  );
}

function ConfigTab({ meta, config, onSave }: { meta: Meta; config: GuildConfig; onSave: (patch: Partial<GuildConfig>) => void }) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);

  function Role({ k, label }: { k: keyof GuildConfig; label: string }) {
    return (
      <label className="field">
        <span>{label}</span>
        <select value={(draft[k] as string) ?? ""} onChange={e => setDraft({ ...draft, [k]: e.target.value || null })}>
          <option value="">なし</option>
          {meta.roles.map(r => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function Chan({ k, label }: { k: keyof GuildConfig; label: string }) {
    return (
      <label className="field">
        <span>{label}</span>
        <select value={(draft[k] as string) ?? ""} onChange={e => setDraft({ ...draft, [k]: e.target.value || null })}>
          <option value="">なし</option>
          {meta.channels.map(c => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <section className="card" style={{ padding: 24 }}>
      <div className="section-head">
        <h2>サーバー設定</h2>
        <button className="primary" onClick={() => onSave(draft)}>
          保存
        </button>
      </div>
      <div className="form-grid two">
        <Role k="admin_role_id" label="管理者ロール" />
        <Role k="mod_role_id" label="モデレーターロール" />
        <Chan k="log_channel_id" label="ログチャンネル" />
        <Role k="verified_role_id" label="認証済みロール" />
        <Chan k="verify_channel_id" label="認証チャンネル" />
        <Chan k="welcome_channel_id" label="入室メッセージ送信先" />
        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span>入室メッセージ（{"{user}"} でメンション）</span>
          <input value={draft.welcome_message ?? ""} onChange={e => setDraft({ ...draft, welcome_message: e.target.value })} />
        </label>
        <Chan k="leave_channel_id" label="退室メッセージ送信先" />
        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span>退室メッセージ（{"{user}"} でメンション）</span>
          <input value={draft.leave_message ?? ""} onChange={e => setDraft({ ...draft, leave_message: e.target.value })} />
        </label>
      </div>

      <div className="toggle-stack">
        <div className="toggle-row">
          <div className="toggle-copy">
            <strong>Anti-Spam</strong>
            <small>短時間の連投を検知します</small>
          </div>
          <label className={`switch ${draft.anti_spam_enabled ? "on" : ""}`}>
            <input type="checkbox" checked={Boolean(draft.anti_spam_enabled)} onChange={e => setDraft({ ...draft, anti_spam_enabled: e.target.checked ? 1 : 0 })} />
            <span />
          </label>
        </div>
        <div className="toggle-row">
          <div className="toggle-copy">
            <strong>Anti-Link</strong>
            <small>不審なリンクの投稿を検知します</small>
          </div>
          <label className={`switch ${draft.anti_link_enabled ? "on" : ""}`}>
            <input type="checkbox" checked={Boolean(draft.anti_link_enabled)} onChange={e => setDraft({ ...draft, anti_link_enabled: e.target.checked ? 1 : 0 })} />
            <span />
          </label>
        </div>
        <div className="toggle-row">
          <div className="toggle-copy">
            <strong>Raid Protection</strong>
            <small>短時間の大量参加を検知します</small>
          </div>
          <label className={`switch ${draft.raid_protection_enabled ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={Boolean(draft.raid_protection_enabled)}
              onChange={e => setDraft({ ...draft, raid_protection_enabled: e.target.checked ? 1 : 0 })}
            />
            <span />
          </label>
        </div>
      </div>
    </section>
  );
}

function PanelsTab({
  meta,
  panels,
  panelButtons,
  onCreatePanel,
  onAddButton,
  onDeleteButton,
  onPostPanel
}: {
  meta: Meta;
  panels: Panel[];
  panelButtons: Record<number, PanelButton[]>;
  onCreatePanel: (title: string, description: string) => void;
  onAddButton: (panelId: number, data: { label: string; style: string; action_type: string; action_value: string }) => void;
  onDeleteButton: (panelId: number, buttonId: number) => void;
  onPostPanel: (panelId: number, channelId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");

  return (
    <section className="stack">
      <div className="card" style={{ padding: 24 }}>
        <h2>新規パネル作成</h2>
        <div className="form-grid two">
          <label className="field">
            <span>タイトル</span>
            <input value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>説明文（任意）</span>
            <input value={desc} onChange={e => setDesc(e.target.value)} />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary"
            onClick={() => {
              onCreatePanel(title, desc);
              setTitle("");
              setDesc("");
            }}
          >
            作成
          </button>
        </div>
      </div>

      {panels.map(p => (
        <PanelCard key={p.id} panel={p} meta={meta} buttons={panelButtons[p.id] ?? []} onAddButton={onAddButton} onDeleteButton={onDeleteButton} onPost={onPostPanel} />
      ))}
    </section>
  );
}

function PanelCard({
  panel,
  meta,
  buttons,
  onAddButton,
  onDeleteButton,
  onPost
}: {
  panel: Panel;
  meta: Meta;
  buttons: PanelButton[];
  onAddButton: (panelId: number, data: { label: string; style: string; action_type: string; action_value: string }) => void;
  onDeleteButton: (panelId: number, buttonId: number) => void;
  onPost: (panelId: number, channelId: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [style, setStyle] = useState("Primary");
  const [actionType, setActionType] = useState("toggle_role");
  const [actionValue, setActionValue] = useState("");
  const [channelId, setChannelId] = useState("");

  return (
    <div className="card" style={{ padding: 24 }}>
      <div className="section-head">
        <h2>{panel.title}</h2>
      </div>
      {panel.description && <p className="muted">{panel.description}</p>}

      <div className="button-row" style={{ flexWrap: "wrap" }}>
        {buttons.map(b => (
          <span key={b.id} className="status-pill">
            {b.label} ({STYLE_LABEL[b.style] ?? b.style})
            <button className="icon-button" onClick={() => onDeleteButton(panel.id, b.id)} title="削除">
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="form-grid three" style={{ marginTop: 16 }}>
        <label className="field">
          <span>ラベル</span>
          <input value={label} onChange={e => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span>色</span>
          <select value={style} onChange={e => setStyle(e.target.value)}>
            {Object.entries(STYLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>アクション</span>
          <select value={actionType} onChange={e => setActionType(e.target.value)}>
            <option value="toggle_role">ロール付与/剥奪</option>
            <option value="show_text">テキスト表示</option>
          </select>
        </label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span>ロールID or テキスト</span>
          <input value={actionValue} onChange={e => setActionValue(e.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button
          className="secondary"
          onClick={() => {
            if (!label.trim() || !actionValue.trim()) return;
            onAddButton(panel.id, { label: label.trim(), style, action_type: actionType, action_value: actionValue.trim() });
            setLabel("");
            setActionValue("");
          }}
        >
          ボタン追加
        </button>
      </div>

      <div className="form-grid two" style={{ marginTop: 16 }}>
        <label className="field">
          <span>投稿先チャンネル</span>
          <select value={channelId} onChange={e => setChannelId(e.target.value)}>
            <option value="">チャンネルを選択</option>
            {meta.channels.map(c => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="button-row">
        <button className="primary" onClick={() => onPost(panel.id, channelId)} disabled={!channelId}>
          投稿
        </button>
      </div>
    </div>
  );
}

function AmazonTab({
  meta,
  avConfig,
  onSave,
  onPost
}: {
  meta: Meta;
  avConfig: AvConfig;
  onSave: (cfg: AvConfig) => void;
  onPost: (channelId: string) => void;
}) {
  const [draft, setDraft] = useState(avConfig);
  const [channelId, setChannelId] = useState("");
  useEffect(() => setDraft(avConfig), [avConfig]);

  return (
    <section className="stack">
      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <h2>Amazon自販機 設定</h2>
          <button className="primary" onClick={() => onSave(draft)}>
            設定保存
          </button>
        </div>
        <div className="form-grid two">
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>パネルタイトル</span>
            <input maxLength={100} value={draft.panel_title} onChange={e => setDraft({ ...draft, panel_title: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>パネル説明文</span>
            <textarea maxLength={500} value={draft.panel_description ?? ""} onChange={e => setDraft({ ...draft, panel_description: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>LTCアドレス</span>
            <input placeholder="Lxxxxxxxxxx..." value={draft.ltc_address ?? ""} onChange={e => setDraft({ ...draft, ltc_address: e.target.value })} />
          </label>
          <label className="field">
            <span>API種別</span>
            <select value={draft.api_type} onChange={e => setDraft({ ...draft, api_type: e.target.value })}>
              <option value="rainforest">Rainforest API</option>
              <option value="keepa">Keepa API</option>
              <option value="canopy">Canopy API</option>
            </select>
          </label>
          <label className="field">
            <span>APIキー</span>
            <input type="password" value={draft.api_key ?? ""} onChange={e => setDraft({ ...draft, api_key: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>パネルを設置</h2>
        <div className="form-grid two">
          <label className="field">
            <span>投稿先チャンネル</span>
            <select value={channelId} onChange={e => setChannelId(e.target.value)}>
              <option value="">チャンネルを選択</option>
              {meta.channels.map(c => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="button-row">
          <button className="primary" onClick={() => onPost(channelId)} disabled={!channelId}>
            投稿
          </button>
        </div>
      </div>
    </section>
  );
}
