import { useEffect, useState } from "react";
import { api } from "./api";
import Field from "./Field";

type Channel = { id: string; name: string; type: number; parent_id: string | null };

type SecurityModules = {
  antiNuke: boolean; antiRaid: boolean; antiSpam: boolean; antiPhishing: boolean;
  dangerousAttachments: boolean; botGuard: boolean; webhookGuard: boolean; roleGuard: boolean;
  permissionGuard: boolean; automodGuard: boolean; guildGuard: boolean; memberGuard: boolean;
};

type SecurityThresholds = {
  actionWindowSeconds: number; crossActionWindowSeconds: number; crossActionScore: number;
  channelDelete: number; channelCreate: number; channelUpdate: number; channelOverwrite: number;
  roleDelete: number; roleCreate: number; roleUpdate: number; banAdd: number; memberPrune: number;
  kick: number; webhook: number; botAdd: number; guildUpdate: number; automodChange: number;
  raidJoins: number; raidWindowSeconds: number; spamMessages: number; spamWindowSeconds: number;
  mentionLimit: number; linkBurst: number; linkWindowSeconds: number; severeContentUsers: number;
  severeContentWindowSeconds: number; minAccountAgeHours: number;
};

type SecurityResponseConfig = {
  stripDangerousRoles: boolean; kickMaliciousBots: boolean; timeoutMinutes: number;
  autoLockdown: boolean; lockdownMinutes: number; deleteUnsafeMessages: boolean; quarantineRaidJoins: boolean;
};

type SecuritySettings = {
  enabled: boolean;
  mode: "audit" | "enforce";
  profile: "balanced" | "strict" | "paranoid";
  modules: SecurityModules;
  thresholds: SecurityThresholds;
  response: SecurityResponseConfig;
  safety: { enforceExplicitContentFilter: boolean; minimumVerificationLevel: number };
  logChannelId: string | null;
  trustedUserIds: string[];
  trustedRoleIds: string[];
  allowedBotIds: string[];
  allowedDomains: string[];
  blockedDomains: string[];
};

type SecurityIncident = { id: string; actorId: string | null; kind: string; severity: string; summary: string; createdAt: number };

type GuildSafetyStatus = {
  explicitContentFilter: number;
  verificationLevel: number;
  mfaLevel: number;
  raidAlertsEnabled: boolean;
  safetyAlertsChannelConfigured: boolean;
  baselineReady: boolean;
};

type SecurityOverview = {
  settings: SecuritySettings;
  status: { connected: boolean; lastEventAt: number | null; reconnectAttempts: number };
  incidents: SecurityIncident[];
  lockdown: { active: boolean; expiresAt: number | null; reason: string | null; manualUnlockAllowed: boolean };
  capabilities: { administrator: boolean; requiredReady: boolean; missingPermissions: string[] };
  maximumInviteUrl: string;
  safetyStatus: GuildSafetyStatus | null;
};

const MODULE_LABELS: Record<keyof SecurityModules, [string, string]> = {
  antiNuke: ["Anti-Nuke", "チャンネル/ロールの大量削除を検知し自動で封じ込めます"],
  antiRaid: ["Anti-Raid", "短時間の大量参加を検知します"],
  antiSpam: ["Anti-Spam", "短時間の連投・大量メンションを検知します"],
  antiPhishing: ["Anti-Phishing", "フィッシングURL・不審リンクを検知します"],
  dangerousAttachments: ["危険な添付ファイル", "実行可能ファイルの添付を検知します"],
  botGuard: ["Bot Guard", "危険な権限を持つBotの追加を検知します"],
  webhookGuard: ["Webhook Guard", "不審なWebhook作成を検知し削除します"],
  roleGuard: ["Role Guard", "ロールの大量作成・削除を検知します"],
  permissionGuard: ["Permission Guard", "権限昇格・チャンネル権限の不審な変更を検知します"],
  automodGuard: ["AutoMod Guard", "サーバーのAutoMod設定変更を検知します"],
  guildGuard: ["Guild Guard", "サーバー設定自体の不審な変更を検知します"],
  memberGuard: ["Member Guard", "大量Kick/BAN/メンバー削除を検知します"],
};

function Toggle({ value, onChange, title, description, disabled = false }: { value: boolean; onChange: (value: boolean) => void; title: string; description: string; disabled?: boolean }) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span className="toggle-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`switch ${value ? "on" : ""}`}>
        <input type="checkbox" checked={value} disabled={disabled} onChange={event => onChange(event.target.checked)} />
        <span />
      </span>
    </label>
  );
}

function severityColor(severity: string): string {
  if (severity === "critical") return "bad";
  if (severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "good";
}

export default function SecurityManager({ guildId, channels }: { guildId: string; channels: Channel[] }) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [draft, setDraft] = useState<SecuritySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<SecurityOverview>(`/api/guilds/${guildId}/security-center`);
      setOverview(data);
      setDraft(data.settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [guildId]);

  // Explicit refresh (the ボタン below) surfaces connection errors; this
  // background poll stays quiet so a transient Gateway blip doesn't spam
  // an error on every tick.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await api<SecurityOverview>(`/api/guilds/${guildId}/security-center`);
        if (cancelled) return;
        setOverview(prev => (prev ? { ...prev, status: data.status, lockdown: data.lockdown, incidents: data.incidents } : data));
      } catch {
        // quiet
      }
    }, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [guildId]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<SecuritySettings>(`/api/guilds/${guildId}/security-center/settings`, { method: "PUT", body: JSON.stringify(draft) });
      setDraft(saved);
      setOverview(prev => (prev ? { ...prev, settings: saved } : prev));
      setNotice("セキュリティ設定を保存しました");
      window.setTimeout(() => setNotice(null), 3500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function lockdown() {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/security-center/lockdown`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/security-center/lockdown`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!draft || !overview) {
    return (
      <section className="card" style={{ padding: 24 }}>
        {error ? <div className="alert error">{error}</div> : <p className="muted">読み込み中...</p>}
      </section>
    );
  }

  const logChannels = channels.filter(c => c.type === 0 || c.type === 5);

  return (
    <section className="stack">
      {notice && <div className="alert success">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">SECURITY</span>
            <h2>セキュリティ</h2>
          </div>
          <div className="button-row" style={{ marginTop: 0 }}>
            <span className={`status-pill ${overview.status.connected ? "good" : "bad"}`}>
              <i /> Gateway {overview.status.connected ? "Online" : "Offline"}
            </span>
            {!overview.capabilities.requiredReady && (
              <span className="status-pill warn" title={overview.capabilities.missingPermissions.join(", ")}>
                <i /> 権限不足
              </span>
            )}
            <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
              セキュリティ設定を保存
            </button>
          </div>
        </div>

        {!overview.capabilities.requiredReady && (
          <div className="alert error">
            Botに必要な権限が不足しています: {overview.capabilities.missingPermissions.join(", ")}
            {" "}
            <a href={overview.maximumInviteUrl} target="_blank" rel="noreferrer">権限を再付与する招待リンク</a>
          </div>
        )}

        <div className="form-grid two">
          <label className="field">
            <span>動作モード</span>
            <select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as "audit" | "enforce" })}>
              <option value="enforce">enforce（検知して自動対処）</option>
              <option value="audit">audit（記録のみ・自動対処なし）</option>
            </select>
          </label>
          <label className="field">
            <span>プリセット</span>
            <select value={draft.profile} onChange={e => setDraft({ ...draft, profile: e.target.value as SecuritySettings["profile"] })}>
              <option value="balanced">balanced</option>
              <option value="strict">strict</option>
              <option value="paranoid">paranoid</option>
            </select>
          </label>
        </div>

        <div className="toggle-stack">
          <Toggle title="セキュリティ機能を有効化" description="オフにするとすべての検知・自動対処を停止します" value={draft.enabled} onChange={value => setDraft({ ...draft, enabled: value })} />
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>検知モジュール</h2>
        <div className="toggle-stack">
          {(Object.keys(MODULE_LABELS) as Array<keyof SecurityModules>).map(key => {
            const [title, description] = MODULE_LABELS[key];
            return (
              <Toggle
                key={key}
                title={title}
                description={description}
                value={draft.modules[key]}
                onChange={value => setDraft({ ...draft, modules: { ...draft.modules, [key]: value } })}
              />
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">SERVER SAFETY</span>
            <h2>Discord Safety Baseline</h2>
            <p className="muted">Discord標準の安全フィルターも合わせて強制維持します。</p>
          </div>
          <strong>{overview.safetyStatus?.baselineReady ? "READY" : "CHECK"}</strong>
        </div>

        <div className="toggle-stack">
          <Toggle
            title="Explicit Content Filter: ALL MEMBERS"
            description="常時有効にし、全メンバーのメディアをスキャンします"
            value={draft.safety.enforceExplicitContentFilter}
            onChange={value => setDraft({ ...draft, safety: { ...draft.safety, enforceExplicitContentFilter: value } })}
          />
        </div>

        <div className="form-grid two">
          <Field label="最低Verification Level">
            <select
              value={draft.safety.minimumVerificationLevel}
              onChange={e => setDraft({ ...draft, safety: { ...draft.safety, minimumVerificationLevel: Number(e.target.value) } })}
            >
              <option value={0}>None</option>
              <option value={1}>Low（メール認証）</option>
              <option value={2}>Medium（推奨最低値）</option>
              <option value={3}>High</option>
              <option value={4}>Very High（電話番号認証）</option>
            </select>
          </Field>
          <Field label="現在のExplicit Filter">
            <input
              readOnly
              value={
                overview.safetyStatus
                  ? overview.safetyStatus.explicitContentFilter === 2
                    ? "ALL MEMBERS"
                    : overview.safetyStatus.explicitContentFilter === 1
                      ? "MEMBERS WITHOUT ROLES"
                      : "DISABLED"
                  : "取得待ち"
              }
            />
          </Field>
          <Field label="Server 2FA">
            <input readOnly value={overview.safetyStatus?.mfaLevel === 1 ? "ENABLED" : "DISABLED"} />
          </Field>
          <Field label="Raid Alerts">
            <input readOnly value={overview.safetyStatus?.raidAlertsEnabled ? "ENABLED" : "DISABLED / UNKNOWN"} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>自動対処</h2>
        <div className="toggle-stack">
          <Toggle title="危険なロールの剥奪" description="制裁対象から危険な権限を持つロールを剥奪します" value={draft.response.stripDangerousRoles} onChange={value => setDraft({ ...draft, response: { ...draft.response, stripDangerousRoles: value } })} />
          <Toggle title="悪性Botの自動Kick" description="検知した悪性Botを自動でKickします" value={draft.response.kickMaliciousBots} onChange={value => setDraft({ ...draft, response: { ...draft.response, kickMaliciousBots: value } })} />
          <Toggle title="自動Lockdown" description="高信頼度の攻撃を検知した際に自動でサーバーをLockdownします" value={draft.response.autoLockdown} onChange={value => setDraft({ ...draft, response: { ...draft.response, autoLockdown: value } })} />
          <Toggle title="危険な投稿の自動削除" description="フィッシング/スパムと判定した投稿を自動削除します" value={draft.response.deleteUnsafeMessages} onChange={value => setDraft({ ...draft, response: { ...draft.response, deleteUnsafeMessages: value } })} />
          <Toggle title="Raid参加者の自動タイムアウト" description="Raid中の新規アカウントを自動でタイムアウトします" value={draft.response.quarantineRaidJoins} onChange={value => setDraft({ ...draft, response: { ...draft.response, quarantineRaidJoins: value } })} />
        </div>
        <div className="form-grid two">
          <Field label="制裁タイムアウト（分）">
            <input type="number" min={1} max={40320} value={draft.response.timeoutMinutes} onChange={e => setDraft({ ...draft, response: { ...draft.response, timeoutMinutes: Number(e.target.value) } })} />
          </Field>
          <Field label="Lockdown時間（分）">
            <input type="number" min={1} max={180} value={draft.response.lockdownMinutes} onChange={e => setDraft({ ...draft, response: { ...draft.response, lockdownMinutes: Number(e.target.value) } })} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>しきい値</h2>
        <div className="form-grid three">
          <Field label="検知ウィンドウ（秒）"><input type="number" min={2} max={120} value={draft.thresholds.actionWindowSeconds} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, actionWindowSeconds: Number(e.target.value) } })} /></Field>
          <Field label="チャンネル削除"><input type="number" min={1} max={30} value={draft.thresholds.channelDelete} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, channelDelete: Number(e.target.value) } })} /></Field>
          <Field label="ロール削除"><input type="number" min={1} max={30} value={draft.thresholds.roleDelete} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, roleDelete: Number(e.target.value) } })} /></Field>
          <Field label="BAN"><input type="number" min={1} max={50} value={draft.thresholds.banAdd} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, banAdd: Number(e.target.value) } })} /></Field>
          <Field label="Kick"><input type="number" min={1} max={50} value={draft.thresholds.kick} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, kick: Number(e.target.value) } })} /></Field>
          <Field label="Webhook作成"><input type="number" min={1} max={30} value={draft.thresholds.webhook} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, webhook: Number(e.target.value) } })} /></Field>
          <Field label="Raid参加人数"><input type="number" min={2} max={1000} value={draft.thresholds.raidJoins} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, raidJoins: Number(e.target.value) } })} /></Field>
          <Field label="Raidウィンドウ（秒）"><input type="number" min={2} max={300} value={draft.thresholds.raidWindowSeconds} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, raidWindowSeconds: Number(e.target.value) } })} /></Field>
          <Field label="スパム投稿数"><input type="number" min={2} max={50} value={draft.thresholds.spamMessages} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, spamMessages: Number(e.target.value) } })} /></Field>
          <Field label="最低アカウント年齢（時間）"><input type="number" min={0} max={87600} value={draft.thresholds.minAccountAgeHours} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, minAccountAgeHours: Number(e.target.value) } })} /></Field>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>通知・例外設定</h2>
        <Field label="ログチャンネル" hint="Security Incidentの通知を送信するチャンネルです">
          <select value={draft.logChannelId ?? ""} onChange={e => setDraft({ ...draft, logChannelId: e.target.value || null })}>
            <option value="">チャンネルを選択</option>
            {logChannels.map(channel => (
              <option key={channel.id} value={channel.id}>#{channel.name}</option>
            ))}
          </select>
        </Field>
        <div className="form-grid two">
          <Field label="信頼するユーザーID（改行区切り）">
            <textarea
              value={draft.trustedUserIds.join("\n")}
              onChange={e => setDraft({ ...draft, trustedUserIds: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="信頼するロールID（改行区切り）">
            <textarea
              value={draft.trustedRoleIds.join("\n")}
              onChange={e => setDraft({ ...draft, trustedRoleIds: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="信頼するBotID（改行区切り）">
            <textarea
              value={draft.allowedBotIds.join("\n")}
              onChange={e => setDraft({ ...draft, allowedBotIds: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="ブロックするドメイン（改行区切り）">
            <textarea
              value={draft.blockedDomains.join("\n")}
              onChange={e => setDraft({ ...draft, blockedDomains: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
            />
          </Field>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <h2>Lockdown</h2>
          {overview.lockdown.active ? (
            <button type="button" className="danger" onClick={() => void unlock()} disabled={busy || !overview.lockdown.manualUnlockAllowed}>
              Lockdownを解除
            </button>
          ) : (
            <button type="button" className="danger" onClick={() => void lockdown()} disabled={busy}>
              今すぐLockdown
            </button>
          )}
        </div>
        {overview.lockdown.active ? (
          <p className="muted">
            発動中（理由: {overview.lockdown.reason}）。
            {overview.lockdown.expiresAt && ` 自動解除: ${new Date(overview.lockdown.expiresAt).toLocaleString("ja-JP")}`}
            {!overview.lockdown.manualUnlockAllowed && " 自動防御による発動のため手動解除はできません。"}
          </p>
        ) : (
          <p className="muted">現在Lockdownは発動していません。</p>
        )}
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>Incident Log</h2>
        {overview.incidents.length === 0 && <p className="muted">まだ記録はありません。</p>}
        <div className="stack">
          {overview.incidents.map(incident => (
            <div key={incident.id} className="toggle-row">
              <span className="toggle-copy">
                <strong>{incident.summary}</strong>
                <small>{incident.kind} · {incident.actorId ? `<@${incident.actorId}>` : "actor不明"} · {new Date(incident.createdAt).toLocaleString("ja-JP")}</small>
              </span>
              <span className={`status-pill ${severityColor(incident.severity)}`}>
                <i /> {incident.severity}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
