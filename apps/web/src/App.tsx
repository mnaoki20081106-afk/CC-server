import { useEffect, useMemo, useState } from "react";
import { api, clearSession, currentSession, login } from "./api";
import ServerEditor, { type ServerConfig } from "./ServerEditor";
import SecurityManager from "./SecurityManager";
import Panels, { type Panel, type PanelButton } from "./Panels";
import AmazonVending, { type AvConfig } from "./AmazonVending";

type Guild = { id: string; name: string; icon: string | null };
type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Role = { id: string; name: string; color: number };
type Meta = { id: string; name: string; icon: string | null; channels: Channel[]; roles: Role[] };

type GuildConfig = ServerConfig;

type ServiceStatus = {
  discordReady: boolean;
  discordUser?: string | null;
  discordError?: string | null;
  guildCount?: number | null;
  inviteUrl: string;
};

type ActiveTab = "server" | "security" | "panels" | "amazon";

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
  const [activeTab, setActiveTab] = useState<ActiveTab>("server");

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
      const serverList = await api<Guild[]>("/api/guilds");
      setGuilds(serverList);
      if (!selectedId && serverList.length > 0) await selectGuild(serverList[0].id);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }

    // /api/status is a nice-to-have (bot health pill + invite link) — a
    // Worker deploy that doesn't have this route yet, or a transient
    // failure, must not block the guild list above.
    try {
      setStatus(await api<ServiceStatus>("/api/status"));
    } catch {
      setStatus(null);
    }
  }

  async function selectGuild(guildId: string) {
    setBusy(true);
    setError(null);
    try {
      const [m, c] = await Promise.all([api<Meta>(`/api/guilds/${guildId}/meta`), api<GuildConfig>(`/api/guilds/${guildId}/config`)]);
      setMeta(m);
      setConfig(c);
      setSelectedId(guildId);
      setActiveTab("server");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(patch: Partial<GuildConfig>, successMessage: string) {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${selectedId}/config`, { method: "PUT", body: JSON.stringify(patch) });
      setConfig(prev => (prev ? { ...prev, ...patch } : prev));
      flash(successMessage);
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
      const entries = await Promise.all(list.map(async p => [p.id, await api<PanelButton[]>(`/api/guilds/${selectedId}/panels/${p.id}/buttons`)] as const));
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
      await api(`/api/guilds/${selectedId}/panels`, { method: "POST", body: JSON.stringify({ title: title.trim(), description: description.trim() || null }) });
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
            <button key={guild.id} className={`server-button ${selectedId === guild.id ? "active" : ""}`} onClick={() => void selectGuild(guild.id)}>
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
              <button type="button" role="tab" aria-selected={activeTab === "server"} className={activeTab === "server" ? "active" : ""} onClick={() => setActiveTab("server")}>
                サーバー設定
              </button>
              <button type="button" role="tab" aria-selected={activeTab === "security"} className={activeTab === "security" ? "active" : ""} onClick={() => setActiveTab("security")}>
                セキュリティ
              </button>
              <button type="button" role="tab" aria-selected={activeTab === "panels"} className={activeTab === "panels" ? "active" : ""} onClick={() => setActiveTab("panels")}>
                パネル
              </button>
              <button type="button" role="tab" aria-selected={activeTab === "amazon"} className={activeTab === "amazon" ? "active" : ""} onClick={() => setActiveTab("amazon")}>
                Amazon自販機
              </button>
            </nav>

            {activeTab === "server" && <ServerEditor meta={meta} config={config} onSave={patch => void saveConfig(patch, "サーバー設定を保存しました")} />}
            {activeTab === "security" && <SecurityManager guildId={selectedGuild.id} channels={meta.channels} />}
            {activeTab === "panels" && (
              <Panels
                meta={meta}
                panels={panels}
                panelButtons={panelButtons}
                onCreatePanel={createPanel}
                onAddButton={addButton}
                onDeleteButton={deleteButton}
                onPostPanel={postPanel}
              />
            )}
            {activeTab === "amazon" && avConfig && <AmazonVending meta={meta} avConfig={avConfig} onSave={saveAvConfig} onPost={postAvPanel} />}
          </>
        )}
      </main>
    </div>
  );
}
