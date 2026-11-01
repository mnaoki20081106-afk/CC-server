import { useEffect, useState } from "react";
import { api } from "./api";
import Field from "./Field";

type Backup = {
  id: string;
  sourceGuildId: string;
  sourceGuildName: string;
  label: string | null;
  createdAt: number;
  roleCount: number;
  channelCount: number;
  memberCount: number;
  warnings: string[];
};

type Preview = {
  source: { id: string; name: string };
  target: { id: string; name: string };
  counts: { roles: number; missingRoles: number; channels: number; missingChannels: number; members: number; bans: number };
  behavior: { destructive: boolean; reusesMatching: boolean; memberRestoreLimitedToPresentMembers: boolean };
  warnings: string[];
};

type RestoreStats = {
  rolesCreated: number; rolesUpdated: number; channelsCreated: number; channelsUpdated: number;
  membersUpdated: number; membersNotPresent: number; bansRestored: number; guildExtrasRestored: boolean; warnings: string[];
};

type RestoreJob = {
  id: string;
  backup_id: string;
  target_guild_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function formatDate(value: number) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export default function BackupManager({ guildId, onNotice, onError }: { guildId: string; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [jobs, setJobs] = useState<RestoreJob[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ backup: Backup; data: Preview } | null>(null);
  const [confirmText, setConfirmText] = useState("");

  async function load() {
    try {
      const [backupRows, jobRows] = await Promise.all([
        api<Backup[]>("/api/backups"),
        api<RestoreJob[]>(`/api/restore-jobs?target_guild_id=${encodeURIComponent(guildId)}`),
      ]);
      setBackups(backupRows);
      setJobs(jobRows);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  // Poll while a restore job for this guild is still running.
  useEffect(() => {
    if (!jobs.some(j => j.status === "running")) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  async function createBackup() {
    setBusy("create");
    try {
      await api(`/api/guilds/${guildId}/backups`, { method: "POST", body: JSON.stringify({ label: label.trim() || null }) });
      setLabel("");
      onNotice("バックアップを作成しました");
      await load();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function deleteBackup(backup: Backup) {
    if (!window.confirm(`「${backup.label || backup.sourceGuildName}」のバックアップを削除します。復元できなくなります。よろしいですか？`)) return;
    setBusy(backup.id);
    try {
      await api(`/api/backups/${backup.id}`, { method: "DELETE" });
      onNotice("バックアップを削除しました");
      await load();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function cancelJob(job: RestoreJob) {
    setBusy(job.id);
    try {
      await api(`/api/restore-jobs/${job.id}`, { method: "DELETE" });
      onNotice("復元ジョブを停止しました");
      await load();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function openPreview(backup: Backup) {
    setBusy(backup.id);
    try {
      const data = await api<Preview>(`/api/backups/${backup.id}/restore/preview`, { method: "POST", body: JSON.stringify({ target_guild_id: guildId }) });
      setPreview({ backup, data });
      setConfirmText("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function confirmRestore() {
    if (!preview) return;
    setBusy("restore");
    try {
      await api(`/api/backups/${preview.backup.id}/restore`, { method: "POST", body: JSON.stringify({ target_guild_id: guildId }) });
      setPreview(null);
      onNotice("リストアを開始しました。進捗はこの画面で確認できます。");
      await load();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="stack">
      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">DISASTER RECOVERY</span>
            <h2>バックアップ</h2>
            <p className="muted">ロール・チャンネル・権限・メンバーのロール/ニックネーム・BAN一覧・サーバー設定を保存します。</p>
          </div>
          <button type="button" className="secondary" onClick={() => void load()} disabled={busy !== null}>
            再読み込み
          </button>
        </div>
        <div className="form-grid two">
          <Field label="ラベル（任意）">
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="例: イベント前" />
          </Field>
        </div>
        <div className="button-row">
          <button type="button" className="primary" onClick={() => void createBackup()} disabled={busy === "create"}>
            {busy === "create" ? "作成中..." : "今すぐバックアップを作成"}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <h3>復元できる範囲とDiscord側の制約</h3>
        </div>
        <p className="muted">
          復元対象: サーバー基本設定、@everyoneを含むロール権限、カテゴリ/チャンネル配置と権限、
          メンバーID・ロール・ニックネーム・有効なタイムアウト、BAN一覧、Welcome Screen。
          既存のロール・チャンネルは削除せず、一致するものを再利用して不足分だけ追加します。
        </p>
        <p className="muted">
          Discord API上、そのまま復元できないもの: 過去メッセージを元の投稿者・元のMessage IDのまま戻すこと、
          外部Integrationや他社Botを本人/提供元の再認証なしで再導入すること、Server Boost・所有権・監査ログ・
          元の招待コードをそのまま再現すること。退出済みメンバーの再招待もサポートしていません
          （現在サーバーに残っているメンバーのみ、ロール・ニックネーム・タイムアウトを復元します）。
        </p>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>バックアップ一覧</h2>
        {backups.length === 0 && <p className="muted">まだバックアップがありません。</p>}
        <div className="stack">
          {backups.map(backup => (
            <div key={backup.id} className="toggle-row">
              <span className="toggle-copy">
                <strong>{backup.label || backup.sourceGuildName}</strong>
                <small>
                  {formatDate(backup.createdAt)} · ロール{backup.roleCount} · チャンネル{backup.channelCount} · メンバー{backup.memberCount}
                </small>
                {backup.warnings.length > 0 && (
                  <details>
                    <summary>取得時の注意 {backup.warnings.length}件</summary>
                    <ul>{backup.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </details>
                )}
              </span>
              <div className="button-row" style={{ marginTop: 0 }}>
                <button type="button" className="secondary" onClick={() => void openPreview(backup)} disabled={busy === backup.id}>
                  このサーバーへ復元
                </button>
                <button type="button" className="danger" onClick={() => void deleteBackup(backup)} disabled={busy === backup.id}>
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>リストア履歴</h2>
        {jobs.length === 0 && <p className="muted">まだリストアは実行されていません。</p>}
        <div className="stack">
          {jobs.map(job => {
            const stats = (() => { try { return JSON.parse(job.result_json) as RestoreStats; } catch { return null; } })();
            return (
              <div key={job.id} className="toggle-row">
                <span className="toggle-copy">
                  <strong>
                    {job.status === "running" ? "実行中..." : job.status === "completed" ? "完了" : job.status === "cancelled" ? "停止済み" : "失敗"}
                  </strong>
                  <small>
                    {formatDate(job.created_at)}
                    {stats && ` · ロール作成${stats.rolesCreated}/更新${stats.rolesUpdated} · チャンネル作成${stats.channelsCreated}/更新${stats.channelsUpdated} · メンバー復元${stats.membersUpdated}（未在籍${stats.membersNotPresent}） · BAN${stats.bansRestored}`}
                    {job.error && ` · エラー: ${job.error}`}
                  </small>
                  {stats && stats.warnings.length > 0 && (
                    <details>
                      <summary>注意 {stats.warnings.length}件</summary>
                      <ul>{stats.warnings.slice(-8).map((w, i) => <li key={i}>{w}</li>)}</ul>
                    </details>
                  )}
                  {job.status === "running" && (
                    <div className="button-row" style={{ marginTop: 6 }}>
                      <button type="button" className="danger" onClick={() => void cancelJob(job)} disabled={busy !== null}>
                        復元を停止
                      </button>
                    </div>
                  )}
                </span>
                <span className={`status-pill ${job.status === "completed" ? "good" : job.status === "failed" ? "bad" : ""}`}>
                  <i /> {job.status}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {preview && (
        <div className="card" style={{ padding: 24, borderColor: "#55262d" }}>
          <div className="section-head">
            <h2>リストアの確認</h2>
          </div>
          <div className="alert error">
            このサーバー（{preview.data.target.name}）に「{preview.backup.label || preview.backup.sourceGuildName}」の内容を復元します。
            既存の同名ロール・チャンネルは上書きされます。この操作は取り消せません。
          </div>
          <div className="form-grid three">
            <div className="metric card"><span>ロール</span><strong>{preview.data.counts.roles}</strong><small>未作成分 {preview.data.counts.missingRoles}</small></div>
            <div className="metric card"><span>チャンネル</span><strong>{preview.data.counts.channels}</strong><small>未作成分 {preview.data.counts.missingChannels}</small></div>
            <div className="metric card"><span>メンバー / BAN</span><strong>{preview.data.counts.members} / {preview.data.counts.bans}</strong><small>在籍者のみ復元</small></div>
          </div>
          {preview.data.warnings.map((w, i) => (
            <div key={i} className="alert error">{w}</div>
          ))}
          <Field label='続行するには "restore" と入力してください'>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="restore" />
          </Field>
          <div className="button-row">
            <button type="button" className="danger" onClick={() => void confirmRestore()} disabled={confirmText !== "restore" || busy === "restore"}>
              {busy === "restore" ? "開始中..." : "復元を実行"}
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              キャンセル
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
