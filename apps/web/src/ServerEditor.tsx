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

// ── role permission groups (xaccount-bot's RoleManager.tsx, ported verbatim) ─
type RolePermissionItem = { key: string; label: string; description: string; bit: bigint };
type RolePermissionGroup = { title: string; items: RolePermissionItem[] };

const ROLE_PERMISSION_GROUPS: RolePermissionGroup[] = [
  {
    title: "管理",
    items: [
      { key: "administrator", label: "Administrator", description: "すべての権限を持つ最上位権限", bit: 8n },
      { key: "manageGuild", label: "サーバー管理", description: "サーバー設定を変更", bit: 32n },
      { key: "manageChannels", label: "チャンネル管理", description: "チャンネルの作成・編集・削除", bit: 16n },
      { key: "manageRoles", label: "ロール管理", description: "下位ロールの作成・編集・付与", bit: 268435456n },
      { key: "viewAuditLog", label: "監査ログを見る", description: "サーバー監査ログを閲覧", bit: 128n },
    ],
  },
  {
    title: "モデレーション",
    items: [
      { key: "kick", label: "メンバーをKick", description: "メンバーをサーバーから退出させる", bit: 2n },
      { key: "ban", label: "メンバーをBan", description: "メンバーをBan / Unban", bit: 4n },
      { key: "moderate", label: "タイムアウト", description: "メンバーをタイムアウト", bit: 1099511627776n },
      { key: "manageMessages", label: "メッセージ管理", description: "他ユーザーのメッセージ削除など", bit: 8192n },
    ],
  },
  {
    title: "テキスト・コミュニティ",
    items: [
      { key: "viewChannel", label: "チャンネルを見る", description: "閲覧可能なチャンネルにアクセス", bit: 1024n },
      { key: "sendMessages", label: "メッセージを送信", description: "テキストチャンネルへ投稿", bit: 2048n },
      { key: "mentionEveryone", label: "@everyone をメンション", description: "@everyone / @here を使用", bit: 131072n },
      { key: "manageThreads", label: "スレッド管理", description: "スレッドの編集・削除", bit: 17179869184n },
      { key: "manageWebhooks", label: "Webhook管理", description: "Webhookの作成・編集・削除", bit: 536870912n },
    ],
  },
  {
    title: "ボイス",
    items: [
      { key: "connect", label: "接続", description: "ボイスチャンネルへ接続", bit: 1048576n },
      { key: "speak", label: "発言", description: "ボイスチャンネルで発言", bit: 2097152n },
    ],
  },
];

function roleColorHex(color: number): string {
  const safe = Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, color)) : 0;
  return "#" + safe.toString(16).padStart(6, "0");
}

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

  // role editor (ported from xaccount-bot's RoleManager.tsx)
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [roleCreating, setRoleCreating] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [roleColor, setRoleColor] = useState(0);
  const [roleColorHexInput, setRoleColorHexInput] = useState("#000000");
  const [rolePermissions, setRolePermissions] = useState(0n);
  const [roleSaving, setRoleSaving] = useState(false);

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

  const selectedRole = roles.find(r => r.id === selectedRoleId) ?? null;

  function loadRole(role: EditorRole) {
    setRoleCreating(false);
    setSelectedRoleId(role.id);
    setRoleName(role.name);
    setRoleColor(role.color ?? 0);
    setRoleColorHexInput(roleColorHex(role.color ?? 0));
    setRolePermissions(BigInt(role.permissions || "0"));
  }

  useEffect(() => {
    if (roleCreating) return;
    if (selectedRole) return;
    const fallback = roles.find(r => r.isEveryone) ?? roles[0] ?? null;
    if (fallback) loadRole(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  function startCreateRole() {
    setRoleCreating(true);
    setSelectedRoleId("");
    setRoleName("");
    setRoleColor(0);
    setRoleColorHexInput("#000000");
    setRolePermissions(0n);
  }

  function toggleRolePermission(bit: bigint) {
    setRolePermissions(current => ((current & bit) === bit ? current & ~bit : current | bit));
  }

  function applyRoleColorHex(value: string) {
    setRoleColorHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) setRoleColor(parseInt(value.slice(1), 16));
  }

  async function saveRole() {
    const name = roleName.trim();
    if (roleCreating && !name) return;
    if (!roleCreating && !selectedRole) return;
    setRoleSaving(true);
    try {
      if (roleCreating) {
        await api(`/api/guilds/${guildId}/roles`, {
          method: "POST",
          body: JSON.stringify({ name, color: roleColor, permissions: rolePermissions.toString() }),
        });
        await load();
        flash("ロールを追加しました");
      } else if (selectedRole) {
        const payload = selectedRole.isEveryone
          ? { permissions: rolePermissions.toString() }
          : { name, color: roleColor, permissions: rolePermissions.toString() };
        await api(`/api/guilds/${guildId}/roles/${selectedRole.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        await load();
        flash(selectedRole.isEveryone ? "@everyone の権限を保存しました" : "ロールを保存しました");
      }
    } catch (reason) { fail(reason); } finally { setRoleSaving(false); }
  }

  async function deleteRole() {
    if (!selectedRole || selectedRole.isEveryone) return;
    if (!window.confirm(`ロール「${selectedRole.name}」を削除しますか？`)) return;
    setRoleSaving(true);
    try {
      await api(`/api/guilds/${guildId}/roles/${selectedRole.id}`, { method: "DELETE" });
      await load();
      flash("ロールを削除しました");
    } catch (reason) { fail(reason); } finally { setRoleSaving(false); }
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

      <section className="card role-manager-card">
        <div className="section-head role-manager-heading">
          <div>
            <span className="eyebrow">ROLE MANAGER</span>
            <h2>ロール管理</h2>
            <p className="muted">ロールの追加・削除・色変更と、サーバー全体の権限を設定できます。</p>
          </div>
          <button type="button" className="primary" onClick={startCreateRole} disabled={roleSaving}>
            ＋ ロール追加
          </button>
        </div>

        <div className="role-manager-layout">
          <div className="role-manager-list">
            {roles.map(role => (
              <button
                type="button"
                key={role.id}
                className={!roleCreating && selectedRoleId === role.id ? "role-manager-item active" : "role-manager-item"}
                onClick={() => loadRole(role)}
              >
                <span className="role-color-dot" style={{ backgroundColor: role.color ? roleColorHex(role.color) : "#747f8d" }} />
                <span className="role-manager-item-copy">
                  <strong>{role.isEveryone ? "@everyone" : role.name}</strong>
                  <small>{role.isEveryone ? "BASE ROLE" : `POSITION ${role.position}`}</small>
                </span>
                <span className="role-manager-chevron">›</span>
              </button>
            ))}
            {roles.length === 0 && <div className="role-manager-empty">まだ編集可能なロールがありません。</div>}
          </div>

          <form className="role-manager-editor" onSubmit={e => { e.preventDefault(); void saveRole(); }}>
            <div className="role-editor-title">
              <div>
                <span className="eyebrow">{roleCreating ? "CREATE ROLE" : "EDIT ROLE"}</span>
                <h3>{roleCreating ? "新しいロール" : selectedRole?.isEveryone ? "@everyone" : selectedRole?.name ?? "ロールを選択"}</h3>
              </div>
              {!roleCreating && selectedRole && !selectedRole.isEveryone && (
                <button type="button" className="danger" disabled={roleSaving} onClick={() => void deleteRole()}>
                  削除
                </button>
              )}
            </div>

            {(roleCreating || selectedRole) && (
              <>
                {!selectedRole?.isEveryone && (
                  <div className="role-basic-grid">
                    <label>
                      <span>ロール名</span>
                      <input required maxLength={100} value={roleName} onChange={e => setRoleName(e.target.value)} placeholder="Moderator" />
                    </label>
                    <label>
                      <span>ロール色</span>
                      <div className="role-color-editor">
                        <input
                          className="role-color-input"
                          type="color"
                          value={roleColorHex(roleColor)}
                          onChange={e => { setRoleColorHexInput(e.target.value); setRoleColor(parseInt(e.target.value.slice(1), 16)); }}
                        />
                        <input className="role-hex-input" value={roleColorHexInput} onChange={e => applyRoleColorHex(e.target.value)} maxLength={7} spellCheck={false} />
                        <button type="button" className="secondary" onClick={() => { setRoleColor(0); setRoleColorHexInput("#000000"); }}>
                          既定色
                        </button>
                      </div>
                    </label>
                  </div>
                )}

                {selectedRole?.isEveryone && (
                  <div className="role-everyone-note">
                    <strong>@everyone</strong>
                    <span>全メンバーの基礎ロールです。名前・色・削除は変更できませんが、サーバー全体の権限は編集できます。</span>
                  </div>
                )}

                <div className="role-permission-groups">
                  {ROLE_PERMISSION_GROUPS.map(group => (
                    <section className="role-permission-group" key={group.title}>
                      <h4>{group.title}</h4>
                      <div className="role-permission-list">
                        {group.items.map(permission => {
                          const checked = (rolePermissions & permission.bit) === permission.bit;
                          return (
                            <label className={checked ? "role-permission-row enabled" : "role-permission-row"} key={permission.key}>
                              <span className="role-permission-copy">
                                <strong>{permission.label}</strong>
                                <small>{permission.description}</small>
                              </span>
                              <span className={checked ? "role-permission-switch on" : "role-permission-switch"}>
                                <input type="checkbox" checked={checked} onChange={() => toggleRolePermission(permission.bit)} />
                                <span />
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>

                {(rolePermissions & 8n) === 8n && (
                  <div className="role-admin-warning">
                    Administrator はチャンネル個別設定を含む全権限を実質的に許可します。
                  </div>
                )}

                <button className="primary role-save-button" type="submit" disabled={roleSaving}>
                  {roleSaving ? "保存中…" : roleCreating ? "ロールを追加" : "変更を保存"}
                </button>
              </>
            )}
          </form>
        </div>
      </section>

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
