import { FormEvent, useEffect, useState } from "react";
import { api } from "./api";

type ExternalAuth = { id: string; name: string; url: string };

export default function ExternalAuthManager({ guildId }: { guildId: string }) {
  const [auths, setAuths] = useState<ExternalAuth[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!guildId) return;
    setBusy(true);
    try {
      const rows = await api<ExternalAuth[]>(`/api/guilds/${guildId}/external-auths`);
      setAuths(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [guildId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/external-auths`, { method: "POST", body: JSON.stringify({ name: name.trim(), url: url.trim() }) });
      setName("");
      setUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/external-auths/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!guildId) return null;

  return (
    <section className="card" style={{ padding: 24, marginTop: 14 }}>
      <div className="section-head">
        <div>
          <span className="eyebrow">EXTERNAL AUTH</span>
          <h2>他Bot 一括認証リンク管理</h2>
        </div>
      </div>

      <div className="external-auth-note">
        <strong className="warn">⚠️ 一括認証について</strong><br />
        ここに登録したBotは、メンバーが認証を完了したとき、
        <strong className="highlight">1回のボタン操作で全Botの認証ページが同時に開きます。</strong><br />
        メンバーには「このボタン1回で以下の全Botへの認証が行われます」と明示されます。<br />
        追加できるのは <code>https://discord.com/oauth2/authorize?...</code> 形式のURLのみです。
      </div>

      <form onSubmit={add} className="form-grid two">
        <label className="field">
          <span>識別名</span>
          <input placeholder="例: BedrockAA" value={name} onChange={e => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>認証URL</span>
          <input placeholder="https://discord.com/oauth2/authorize?..." value={url} onChange={e => setUrl(e.target.value)} required />
        </label>
        <div className="button-row" style={{ gridColumn: "1 / -1" }}>
          <button type="submit" className="primary" disabled={busy}>追加</button>
        </div>
      </form>

      {error && <div className="alert error">{error}</div>}
      {auths.length > 0 && (
        <p className="muted" style={{ marginTop: 12 }}>
          現在 {auths.length} 個のBotが登録されています。認証時に全て一括で開かれます。
        </p>
      )}

      <ul className="external-auth-list">
        {auths.map(a => (
          <li key={a.id}>
            <div>
              <strong>{a.name}</strong>
              <small>{a.url.slice(0, 80)}{a.url.length > 80 ? "…" : ""}</small>
            </div>
            <button type="button" className="danger" onClick={() => void remove(a.id)} disabled={busy}>削除</button>
          </li>
        ))}
      </ul>
      {auths.length === 0 && <p className="muted">登録なし</p>}
    </section>
  );
}
