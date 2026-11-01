import { useEffect, useState } from "react";
import { api } from "./api";
import Field from "./Field";

type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Role = { id: string; name: string; color: number };
type Meta = { id: string; name: string; icon: string | null; channels: Channel[]; roles: Role[] };

export type ServerConfig = {
  admin_role_id: string | null;
  mod_role_id: string | null;
  verified_role_id: string | null;
  verify_channel_id: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  leave_channel_id: string | null;
  leave_message: string | null;
};

// ── editor-specific data (channels of every type + @everyone) ───────────────
// /api/guilds/:id/meta deliberately only exposes text channels and
// non-managed, non-@everyone roles (shared by Panels/SecurityManager/
// AmazonVending, which only ever assign a role or pick a text channel).
// The channel/role/permission editor below needs categories, voice channels,
// and @everyone as a valid permission target, so it fetches its own dataset.
type EditorChannel = {
  id: string; name: string; type: number; parent_id: string | null; position?: number;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
};
type EditorRole = { id: string; name: string; color: number; position: number; permissions: string; isEveryone: boolean };

const CHANNEL_PERMISSION_GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: "テキスト",
    keys: [
      ["view", "チャンネルを見る"], ["send", "メッセージを送信"], ["history", "履歴を読む"],
      ["react", "リアクション"], ["files", "ファイル添付"], ["embeds", "埋め込みリンク"],
      ["manageMessages", "メッセージの管理"], ["mentionEveryone", "@everyone 等のメンション"],
      ["externalEmojis", "外部の絵文字"], ["pinMessages", "メッセージピン"], ["manageWebhooks", "Webhookの管理"],
      ["createInvite", "招待リンク作成"], ["bypassSlowmode", "スロウモードを無視"],
    ],
  },
  {
    title: "スレッド",
    keys: [
      ["createPublicThreads", "公開スレッド作成"], ["createPrivateThreads", "非公開スレッド作成"],
      ["sendInThreads", "スレッドで送信"], ["manageThreads", "スレッドの管理"],
    ],
  },
  {
    title: "ボイス",
    keys: [
      ["connect", "接続"], ["speak", "発言"], ["stream", "動画・画面共有"], ["useVad", "音声検出を使用"],
      ["muteMembers", "ミュート"], ["deafenMembers", "スピーカー遮断"], ["moveMembers", "メンバーを移動"],
      ["prioritySpeaker", "優先スピーカー"],
    ],
  },
];

const CHANNEL_TYPE_LABEL: Record<number, string> = { 0: "テキスト", 2: "ボイス", 4: "カテゴリ", 5: "アナウンス" };

type PermissionMode = "inherit" | "allow" | "deny";

function nextMode(mode: PermissionMode): PermissionMode {
  if (mode === "inherit") return "allow";
  if (mode === "allow") return "deny";
  return "inherit";
}

function modeOf(channel: EditorChannel | undefined, targetId: string, key: string, bits: Record<string, bigint>): PermissionMode {
  const overwrite = channel?.permission_overwrites?.find(o => o.id === targetId && o.type === 0);
  const bit = bits[key];
  if (!overwrite || !bit) return "inherit";
  const allow = BigInt(overwrite.allow || "0");
  const deny = BigInt(overwrite.deny || "0");
  if ((allow & bit) === bit) return "allow";
  if ((deny & bit) === bit) return "deny";
  return "inherit";
}

// Mirrors apps/worker/src/server-editor.ts's CHANNEL_PERMISSION_BITS exactly —
// only used here to read the *current* mode for display; the actual write
// happens server-side from the patch this component sends.
const CHANNEL_PERMISSION_BITS: Record<string, bigint> = {
  view: 1024n, send: 2048n, history: 65536n, react: 64n, files: 32768n, embeds: 16384n,
  manageMessages: 8192n, mentionEveryone: 131072n, externalEmojis: 262144n,
  pinMessages: 2251799813685248n, manageWebhooks: 536870912n, createInvite: 1n, bypassSlowmode: 4503599627370496n,
  createPublicThreads: 34359738368n, createPrivateThreads: 68719476736n, sendInThreads: 274877906944n, manageThreads: 17179869184n,
  connect: 1048576n, speak: 2097152n, stream: 512n, useVad: 33554432n,
  muteMembers: 4194304n, deafenMembers: 8388608n, moveMembers: 16777216n, prioritySpeaker: 256n,
};

export default function ServerEditor({
  meta,
  config,
  onSave,
}: {
  meta: Meta;
  config: ServerConfig;
  onSave: (patch: Partial<ServerConfig>) => void;
}) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);

  const textChannels = meta.channels.filter(c => c.type === 0 || c.type === 5);

  return (
    <section className="stack">
      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">SERVER</span>
            <h2>サーバー設定</h2>
          </div>
          <button type="button" className="secondary" onClick={() => onSave(draft)}>
            サーバー設定を保存
          </button>
        </div>

        <div className="form-grid two">
          <Field label="管理者ロール">
            <select value={draft.admin_role_id ?? ""} onChange={e => setDraft({ ...draft, admin_role_id: e.target.value || null })}>
              <option value="">ロールを選択</option>
              {meta.roles.map(role => <option key={role.id} value={role.id}>@{role.name}</option>)}
            </select>
          </Field>
          <Field label="モデレーターロール">
            <select value={draft.mod_role_id ?? ""} onChange={e => setDraft({ ...draft, mod_role_id: e.target.value || null })}>
              <option value="">ロールを選択</option>
              {meta.roles.map(role => <option key={role.id} value={role.id}>@{role.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="form-grid two">
          <Field label="認証後ロール">
            <select value={draft.verified_role_id ?? ""} onChange={e => setDraft({ ...draft, verified_role_id: e.target.value || null })}>
              <option value="">ロールを選択</option>
              {meta.roles.map(role => <option key={role.id} value={role.id}>@{role.name}</option>)}
            </select>
          </Field>
          <Field label="認証チャンネル" hint="テキスト / アナウンスチャンネルに設置できます">
            <select value={draft.verify_channel_id ?? ""} onChange={e => setDraft({ ...draft, verify_channel_id: e.target.value || null })}>
              <option value="">チャンネルを選択</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="form-grid two">
          <Field label="入室メッセージ送信先">
            <select value={draft.welcome_channel_id ?? ""} onChange={e => setDraft({ ...draft, welcome_channel_id: e.target.value || null })}>
              <option value="">チャンネルを選択</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </select>
          </Field>
          <Field label="退室メッセージ送信先">
            <select value={draft.leave_channel_id ?? ""} onChange={e => setDraft({ ...draft, leave_channel_id: e.target.value || null })}>
              <option value="">チャンネルを選択</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </select>
          </Field>
          <Field label="入室メッセージ" hint="{user} でメンションに置き換わります">
            <input value={draft.welcome_message ?? ""} onChange={e => setDraft({ ...draft, welcome_message: e.target.value })} />
          </Field>
          <Field label="退室メッセージ" hint="{user} でメンションに置き換わります">
            <input value={draft.leave_message ?? ""} onChange={e => setDraft({ ...draft, leave_message: e.target.value })} />
          </Field>
        </div>
      </div>

      <ChannelRoleEditor guildId={meta.id} />
    </section>
  );
}

function ChannelRoleEditor({ guildId }: { guildId: string }) {
  const [channels, setChannels] = useState<EditorChannel[]>([]);
  const [roles, setRoles] = useState<EditorRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelType, setNewChannelType] = useState<"text" | "voice" | "category">("text");
  const [newChannelParent, setNewChannelParent] = useState("");

  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleColor, setNewRoleColor] = useState("#5865f2");

  const [permChannelId, setPermChannelId] = useState("");
  const [permTargetId, setPermTargetId] = useState("");
  const [permDraft, setPermDraft] = useState<Record<string, PermissionMode>>({});

  const [dragging, setDragging] = useState<{ kind: "channel" | "category"; id: string } | null>(null);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3500);
  }
  function fail(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ channels: EditorChannel[]; roles: EditorRole[] }>(`/api/guilds/${guildId}/server-editor`);
      setChannels(data.channels);
      setRoles(data.roles);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [guildId]);

  useEffect(() => {
    const channel = channels.find(c => c.id === permChannelId);
    const next: Record<string, PermissionMode> = {};
    for (const group of CHANNEL_PERMISSION_GROUPS) {
      for (const [key] of group.keys) {
        next[key] = modeOf(channel, permTargetId, key, CHANNEL_PERMISSION_BITS);
      }
    }
    setPermDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permChannelId, permTargetId, channels]);

  async function createChannel() {
    if (!newChannelName.trim()) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/channels`, {
        method: "POST",
        body: JSON.stringify({ name: newChannelName.trim(), type: newChannelType, parentId: newChannelType === "category" ? undefined : (newChannelParent || undefined) }),
      });
      setNewChannelName("");
      await load();
      flash("チャンネルを作成しました");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }

  async function moveChannel(id: string, patch: { targetId?: string | null; placement?: "before" | "after" | "start"; parentId?: string | null; position?: number }) {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/channels/reorder`, { method: "PATCH", body: JSON.stringify({ id, ...patch }) });
      await load();
    } catch (reason) { fail(reason); } finally { setBusy(false); setDragging(null); }
  }

  async function createRole() {
    if (!newRoleName.trim()) return;
    setBusy(true);
    try {
      const color = parseInt(newRoleColor.replace("#", ""), 16) || 0;
      await api(`/api/guilds/${guildId}/roles`, { method: "POST", body: JSON.stringify({ name: newRoleName.trim(), color }) });
      setNewRoleName("");
      await load();
      flash("ロールを作成しました");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }

  async function renameRole(role: EditorRole, name: string) {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/roles/${role.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await load();
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }

  async function deleteRole(role: EditorRole) {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/roles/${role.id}`, { method: "DELETE" });
      await load();
      flash("ロールを削除しました");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }

  async function savePermissions() {
    if (!permChannelId || !permTargetId) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/channels/${permChannelId}/permissions/${permTargetId}`, {
        method: "PATCH",
        body: JSON.stringify({ permissions: permDraft }),
      });
      await load();
      flash("権限を保存しました");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }

  const categories = channels.filter(c => c.type === 4).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const topLevel = channels.filter(c => c.type !== 4 && !c.parent_id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const byParent = (parentId: string) => channels.filter(c => c.type !== 4 && c.parent_id === parentId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  function ChannelRow({ channel }: { channel: EditorChannel }) {
    return (
      <div
        className="toggle-row"
        draggable
        onDragStart={() => setDragging({ kind: "channel", id: channel.id })}
        onDragOver={e => e.preventDefault()}
        onDrop={() => dragging && dragging.kind === "channel" && dragging.id !== channel.id && void moveChannel(dragging.id, { targetId: channel.id, placement: "before", parentId: channel.parent_id })}
        style={{ cursor: "grab" }}
      >
        <span className="toggle-copy">
          <strong>{CHANNEL_TYPE_LABEL[channel.type] === "ボイス" ? "🔊" : "#"} {channel.name}</strong>
          <small>{CHANNEL_TYPE_LABEL[channel.type] ?? channel.type}</small>
        </span>
        <button type="button" className="secondary" onClick={() => { setPermChannelId(channel.id); }}>
          権限を編集
        </button>
      </div>
    );
  }

  return (
    <>
      {notice && <div className="alert success">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">CHANNELS</span>
            <h2>チャンネル管理</h2>
          </div>
          <button type="button" className="secondary" onClick={() => void load()} disabled={busy}>
            再読み込み
          </button>
        </div>

        <div className="form-grid three">
          <Field label="チャンネル名">
            <input value={newChannelName} onChange={e => setNewChannelName(e.target.value)} />
          </Field>
          <Field label="種別">
            <select value={newChannelType} onChange={e => setNewChannelType(e.target.value as typeof newChannelType)}>
              <option value="text">テキスト</option>
              <option value="voice">ボイス</option>
              <option value="category">カテゴリ</option>
            </select>
          </Field>
          {newChannelType !== "category" && (
            <Field label="カテゴリ">
              <select value={newChannelParent} onChange={e => setNewChannelParent(e.target.value)}>
                <option value="">なし</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="button-row">
          <button type="button" className="primary" onClick={() => void createChannel()} disabled={busy}>
            作成
          </button>
        </div>

        <div className="stack" style={{ marginTop: 16 }} onDragOver={e => e.preventDefault()} onDrop={() => dragging && void moveChannel(dragging.id, { parentId: null, placement: "start" })}>
          {topLevel.map(channel => <ChannelRow key={channel.id} channel={channel} />)}
          {categories.map(category => (
            <div key={category.id} className="card" style={{ padding: 12 }} draggable onDragStart={() => setDragging({ kind: "category", id: category.id })}>
              <div className="toggle-copy" style={{ marginBottom: 8 }}>
                <strong>📁 {category.name}</strong>
              </div>
              <div
                className="stack"
                onDragOver={e => e.preventDefault()}
                onDrop={() => dragging && dragging.kind === "channel" && void moveChannel(dragging.id, { parentId: category.id, placement: "start" })}
              >
                {byParent(category.id).map(channel => <ChannelRow key={channel.id} channel={channel} />)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <h2>ロール管理</h2>
        </div>
        <div className="form-grid three">
          <Field label="ロール名">
            <input value={newRoleName} onChange={e => setNewRoleName(e.target.value)} />
          </Field>
          <Field label="色">
            <input type="color" value={newRoleColor} onChange={e => setNewRoleColor(e.target.value)} />
          </Field>
        </div>
        <div className="button-row">
          <button type="button" className="primary" onClick={() => void createRole()} disabled={busy}>
            作成
          </button>
        </div>

        <div className="stack" style={{ marginTop: 16 }}>
          {roles.map(role => (
            <div key={role.id} className="toggle-row">
              <span className="toggle-copy">
                <strong style={{ color: role.color ? `#${role.color.toString(16).padStart(6, "0")}` : undefined }}>@{role.name}</strong>
              </span>
              {!role.isEveryone && (
                <div className="button-row" style={{ marginTop: 0 }}>
                  <button type="button" className="secondary" onClick={() => { const name = window.prompt("新しいロール名", role.name); if (name) void renameRole(role, name); }}>
                    名前変更
                  </button>
                  <button type="button" className="danger" onClick={() => void deleteRole(role)}>
                    削除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <h2>チャンネル権限</h2>
          <button type="button" className="primary" onClick={() => void savePermissions()} disabled={busy || !permChannelId || !permTargetId}>
            権限を保存
          </button>
        </div>
        <div className="form-grid two">
          <Field label="チャンネル">
            <select value={permChannelId} onChange={e => setPermChannelId(e.target.value)}>
              <option value="">チャンネルを選択</option>
              {channels.filter(c => c.type !== 4).map(c => <option key={c.id} value={c.id}>{CHANNEL_TYPE_LABEL[c.type] === "ボイス" ? "🔊" : "#"}{c.name}</option>)}
            </select>
          </Field>
          <Field label="対象ロール">
            <select value={permTargetId} onChange={e => setPermTargetId(e.target.value)}>
              <option value="">ロールを選択</option>
              {roles.map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
            </select>
          </Field>
        </div>

        {permChannelId && permTargetId && CHANNEL_PERMISSION_GROUPS.map(group => (
          <div key={group.title} style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: "0.85rem", color: "var(--text-muted, #8090aa)", marginBottom: 8 }}>{group.title}</h3>
            <div className="form-grid three">
              {group.keys.map(([key, label]) => {
                const mode = permDraft[key] ?? "inherit";
                return (
                  <button
                    key={key}
                    type="button"
                    className={mode === "allow" ? "secondary" : mode === "deny" ? "danger" : "secondary"}
                    style={{ opacity: mode === "inherit" ? 0.55 : 1, textAlign: "left" }}
                    onClick={() => setPermDraft({ ...permDraft, [key]: nextMode(mode) })}
                  >
                    {label}: {mode === "allow" ? "許可" : mode === "deny" ? "拒否" : "継承"}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
