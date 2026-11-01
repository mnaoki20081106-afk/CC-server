import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
// The live channel/role/permission editor below needs categories, voice
// channels, and @everyone as a valid permission target, so it fetches its
// own dataset from /api/guilds/:id/server-editor.
type EditorChannel = {
  id: string; name: string; type: number; parent_id: string | null; position?: number;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
};
type EditorRole = { id: string; name: string; color: number; position: number; permissions: string; isEveryone: boolean };

function isVoiceType(type: number): boolean { return type === 2 || type === 13; }
function isCategoryType(type: number): boolean { return type === 4; }
function channelIcon(type: number): string { return isVoiceType(type) ? "🔊" : "#"; }

// ── channel permission model (ported from xaccount-bot's ServerEditor) ──────

type PermissionKey =
  "view" | "send" | "history" | "react" | "files" | "embeds" |
  "createPublicThreads" | "createPrivateThreads" | "sendInThreads" | "manageThreads" |
  "manageMessages" | "mentionEveryone" | "externalEmojis" | "pinMessages" | "manageWebhooks" | "createInvite" | "bypassSlowmode" |
  "connect" | "speak" | "stream" | "useVad" | "muteMembers" | "deafenMembers" | "moveMembers" | "prioritySpeaker";

type PermissionMode = "inherit" | "allow" | "deny";
type BulkPermissionMode = PermissionMode | "keep";
type PermissionRow = { key: PermissionKey; label: string };

const CHANNEL_PERMISSION_BITS: Record<PermissionKey, bigint> = {
  view: 1024n, send: 2048n, history: 65536n, react: 64n, files: 32768n, embeds: 16384n,
  createPublicThreads: 34359738368n, createPrivateThreads: 68719476736n, sendInThreads: 274877906944n, manageThreads: 17179869184n,
  manageMessages: 8192n, mentionEveryone: 131072n, externalEmojis: 262144n, pinMessages: 2251799813685248n,
  manageWebhooks: 536870912n, createInvite: 1n, bypassSlowmode: 4503599627370496n,
  connect: 1048576n, speak: 2097152n, stream: 512n, useVad: 33554432n,
  muteMembers: 4194304n, deafenMembers: 8388608n, moveMembers: 16777216n, prioritySpeaker: 256n,
};

const TEXT_PRIMARY_ROWS: PermissionRow[] = [
  { key: "view", label: "チャンネルを見る" }, { key: "send", label: "メッセージを送信" },
  { key: "history", label: "メッセージ履歴を読む" }, { key: "react", label: "リアクションを追加" },
  { key: "files", label: "ファイルを添付" }, { key: "embeds", label: "リンクを埋め込む" },
  { key: "createPublicThreads", label: "公開スレッドを作成" }, { key: "createPrivateThreads", label: "プライベートスレッドを作成" },
  { key: "sendInThreads", label: "スレッド内でメッセージを送信" },
];
const TEXT_ADVANCED_ROWS: PermissionRow[] = [
  { key: "manageMessages", label: "メッセージを管理" }, { key: "manageThreads", label: "スレッドを管理" },
  { key: "mentionEveryone", label: "@everyone / @here をメンション" }, { key: "externalEmojis", label: "外部の絵文字を使用" },
  { key: "createInvite", label: "招待を作成" }, { key: "manageWebhooks", label: "Webhookを管理" },
  { key: "pinMessages", label: "メッセージをピン留め" }, { key: "bypassSlowmode", label: "低速モードを無視" },
];
const VOICE_PRIMARY_ROWS: PermissionRow[] = [
  { key: "view", label: "チャンネルを見る" }, { key: "connect", label: "接続" },
  { key: "speak", label: "発言" }, { key: "stream", label: "ビデオ / 画面共有" },
];
const VOICE_ADVANCED_ROWS: PermissionRow[] = [
  { key: "useVad", label: "音声検出を使用" }, { key: "prioritySpeaker", label: "優先スピーカー" },
  { key: "muteMembers", label: "メンバーをミュート" }, { key: "deafenMembers", label: "メンバーのスピーカーをミュート" },
  { key: "moveMembers", label: "メンバーを移動" }, { key: "bypassSlowmode", label: "低速モードを無視" },
];
function mergeRows(...groups: PermissionRow[][]): PermissionRow[] {
  const seen = new Set<PermissionKey>();
  return groups.flat().filter(row => (seen.has(row.key) ? false : (seen.add(row.key), true)));
}
function permissionGroupsForType(type: number) {
  return isVoiceType(type)
    ? { primary: VOICE_PRIMARY_ROWS, advanced: VOICE_ADVANCED_ROWS }
    : { primary: TEXT_PRIMARY_ROWS, advanced: TEXT_ADVANCED_ROWS };
}
function permissionMode(channel: EditorChannel | undefined, targetId: string, key: PermissionKey): PermissionMode {
  const overwrite = channel?.permission_overwrites?.find(o => o.id === targetId && o.type === 0);
  if (!overwrite) return "inherit";
  const bit = CHANNEL_PERMISSION_BITS[key];
  const allow = BigInt(overwrite.allow || "0");
  const deny = BigInt(overwrite.deny || "0");
  if ((allow & bit) === bit) return "allow";
  if ((deny & bit) === bit) return "deny";
  return "inherit";
}
function makeDraft(mode: PermissionMode): Record<PermissionKey, PermissionMode> {
  return Object.fromEntries((Object.keys(CHANNEL_PERMISSION_BITS) as PermissionKey[]).map(key => [key, mode])) as Record<PermissionKey, PermissionMode>;
}
function makeBulkDraft(mode: BulkPermissionMode): Record<PermissionKey, BulkPermissionMode> {
  return Object.fromEntries((Object.keys(CHANNEL_PERMISSION_BITS) as PermissionKey[]).map(key => [key, mode])) as Record<PermissionKey, BulkPermissionMode>;
}
const EMPTY_DRAFT = makeDraft("inherit");
const EMPTY_BULK_DRAFT = makeBulkDraft("keep");
function draftFor(channel: EditorChannel, targetId: string): Record<PermissionKey, PermissionMode> {
  return Object.fromEntries((Object.keys(CHANNEL_PERMISSION_BITS) as PermissionKey[]).map(key => [key, permissionMode(channel, targetId, key)])) as Record<PermissionKey, PermissionMode>;
}

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

      <LiveServerEditor guildId={meta.id} guildName={meta.name} />
    </section>
  );
}

// ── live server editor (channel tree + permission preview + bulk edit) ──────
// Faithful port of xaccount-bot's ServerEditor/index.tsx "LIVE SERVER EDITOR":
// a Discord-styled channel-tree preview (not a plain form) with a per-role
// permission-badge overlay, desktop drag-and-drop reorder, and mobile
// long-press reorder, plus a bulk multi-channel permission editor.

type Selection =
  | { kind: "channel"; id: string }
  | { kind: "category"; id: string }
  | { kind: "create"; type: "text" | "voice" | "category"; parentId: string | null }
  | null;

type TouchDropTarget =
  | { kind: "channel"; id: string; placement: "before" | "after" }
  | { kind: "category"; id: string }
  | { kind: "uncategorized" }
  | null;

type TouchGesture = {
  channelId: string; identifier: number; startX: number; startY: number;
  grabOffsetX: number; grabOffsetY: number; width: number; height: number;
  timer: number; armed: boolean;
};

function LiveServerEditor({ guildId, guildName }: { guildId: string; guildName: string }) {
  const [channels, setChannels] = useState<EditorChannel[]>([]);
  const [roles, setRoles] = useState<EditorRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function flash(message: string) { setNotice(message); setError(null); window.setTimeout(() => setNotice(null), 3500); }
  function fail(reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); setNotice(null); }
  function onNotice(message: string) { flash(message); }
  function onError(reason: unknown) { fail(reason); }

  async function load() {
    setBusy(true);
    try {
      const data = await api<{ channels: EditorChannel[]; roles: EditorRole[] }>(`/api/guilds/${guildId}/server-editor`);
      setChannels(data.channels);
      setRoles(data.roles);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [guildId]);

  // ── channel-tree / permission-preview / bulk-edit state ───────────────────
  const [selection, setSelection] = useState<Selection>(null);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [parentId, setParentId] = useState("");
  const [createType, setCreateType] = useState<"text" | "voice" | "category">("text");
  const [saving, setSaving] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [permissionSaveFeedback, setPermissionSaveFeedback] = useState<{ kind: "idle" | "saving" | "success" | "error"; message: string; detail?: string }>({
    kind: "idle", message: "権限を変更して「権限を保存」を押してください",
  });
  const [dragging, setDragging] = useState<{ kind: "channel" | "category"; id: string } | null>(null);
  const [pressingChannelId, setPressingChannelId] = useState<string | null>(null);
  const [touchDraggingId, setTouchDraggingId] = useState<string | null>(null);
  const [touchDropTarget, setTouchDropTarget] = useState<TouchDropTarget>(null);
  const [reorderFeedback, setReorderFeedback] = useState<{ kind: "saving" | "success" | "error"; message: string } | null>(null);
  const [touchDragGhost, setTouchDragGhost] = useState<{ channelId: string; name: string; type?: number; width: number; height: number; x: number; y: number } | null>(null);
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const touchDraggingIdRef = useRef<string | null>(null);
  const touchDropTargetRef = useRef<TouchDropTarget>(null);
  const suppressClickUntilRef = useRef(0);
  const channelScrollRef = useRef<HTMLDivElement | null>(null);

  const [permissionTargetId, setPermissionTargetId] = useState(guildId);
  const [permissionDraft, setPermissionDraft] = useState<Record<PermissionKey, PermissionMode>>(EMPTY_DRAFT);
  const [showPermissionBadges, setShowPermissionBadges] = useState(() => localStorage.getItem("cc_show_permission_badges") !== "0");
  const [permissionPreviewRoleId, setPermissionPreviewRoleId] = useState(() => localStorage.getItem(`cc_permission_preview_role_${guildId}`) || guildId);

  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  const [bulkPermissionDraft, setBulkPermissionDraft] = useState<Record<PermissionKey, BulkPermissionMode>>(EMPTY_BULK_DRAFT);
  const [bulkSavingProgress, setBulkSavingProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkApplyLog, setBulkApplyLog] = useState<{ kind: "idle" | "saving" | "success" | "error"; message: string; detail?: string }>({
    kind: "idle", message: "一括反映の結果がここに表示されます",
  });

  const selectedChannel = useMemo(() => (selection?.kind === "channel" ? channels.find(c => c.id === selection.id) ?? null : null), [selection, channels]);
  const selectedCategory = useMemo(() => (selection?.kind === "category" ? channels.find(c => c.id === selection.id && isCategoryType(c.type)) ?? null : null), [selection, channels]);
  const uncategorized = useMemo(() => channels.filter(c => !isCategoryType(c.type) && !c.parent_id), [channels]);
  const categories = useMemo(() => channels.filter(c => isCategoryType(c.type)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), [channels]);
  const childrenOf = (parent: string) => channels.filter(c => !isCategoryType(c.type) && c.parent_id === parent).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const permissionPreviewRole = useMemo(() => (permissionPreviewRoleId === guildId ? null : roles.find(r => r.id === permissionPreviewRoleId) ?? null), [permissionPreviewRoleId, guildId, roles]);
  const permissionPreviewRoleName = permissionPreviewRoleId === guildId ? "@everyone" : permissionPreviewRole ? `@${permissionPreviewRole.name}` : "@everyone";
  const bulkMode = bulkSelectedIds.length > 0;
  const bulkSelectedChannels = useMemo(() => channels.filter(c => bulkSelectedIds.includes(c.id)), [channels, bulkSelectedIds]);
  const bulkPermissionGroups = useMemo(() => {
    const hasText = bulkSelectedChannels.some(c => !isVoiceType(c.type));
    const hasVoice = bulkSelectedChannels.some(c => isVoiceType(c.type));
    if (hasText && hasVoice) return { primary: mergeRows(TEXT_PRIMARY_ROWS, VOICE_PRIMARY_ROWS), advanced: mergeRows(TEXT_ADVANCED_ROWS, VOICE_ADVANCED_ROWS) };
    return hasVoice ? { primary: VOICE_PRIMARY_ROWS, advanced: VOICE_ADVANCED_ROWS } : { primary: TEXT_PRIMARY_ROWS, advanced: TEXT_ADVANCED_ROWS };
  }, [bulkSelectedChannels]);
  const selectedPermissionGroups = selectedChannel ? permissionGroupsForType(selectedChannel.type) : permissionGroupsForType(0);

  useEffect(() => {
    const valid = permissionPreviewRoleId === guildId || roles.some(r => r.id === permissionPreviewRoleId);
    if (valid) return;
    setPermissionPreviewRoleId(guildId);
    setPermissionTargetId(guildId);
    if (selectedChannel) setPermissionDraft(draftFor(selectedChannel, guildId));
    localStorage.setItem(`cc_permission_preview_role_${guildId}`, guildId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionPreviewRoleId, guildId, roles]);

  function renderPermissionRows(rows: PermissionRow[], bulk = false) {
    if (bulk) {
      return rows.map(row => (
        <div className="permission-row bulk-permission-row" key={row.key}>
          <span>{row.label}</span>
          <div className="permission-modes bulk-permission-modes">
            {(["keep", "inherit", "allow", "deny"] as BulkPermissionMode[]).map(mode => (
              <button type="button" key={mode} className={bulkPermissionDraft[row.key] === mode ? "active " + mode : ""} onClick={() => setBulkPermissionDraft({ ...bulkPermissionDraft, [row.key]: mode })}>
                {mode === "keep" ? "変更なし" : mode === "inherit" ? "継承" : mode === "allow" ? "許可" : "拒否"}
              </button>
            ))}
          </div>
        </div>
      ));
    }
    return rows.map(row => (
      <div className="permission-row" key={row.key}>
        <span>{row.label}</span>
        <div className="permission-modes">
          {(["inherit", "allow", "deny"] as PermissionMode[]).map(mode => (
            <button type="button" key={mode} className={permissionDraft[row.key] === mode ? "active " + mode : ""} onClick={() => setPermissionDraft({ ...permissionDraft, [row.key]: mode })}>
              {mode === "inherit" ? "継承" : mode === "allow" ? "許可" : "拒否"}
            </button>
          ))}
        </div>
      </div>
    ));
  }

  function openChannel(id: string) {
    const channel = channels.find(c => c.id === id);
    if (!channel) return;
    setSelection({ kind: "channel", id });
    setName(channel.name);
    setTopic("");
    setParentId(channel.parent_id ?? "");
    setPermissionTargetId(permissionPreviewRoleId);
    setPermissionDraft(draftFor(channel, permissionPreviewRoleId));
    setPermissionSaveFeedback({ kind: "idle", message: "権限を変更して「権限を保存」を押してください" });
  }
  function openCategory(id: string) {
    const category = channels.find(c => c.id === id);
    if (!category) return;
    setSelection({ kind: "category", id });
    setName(category.name);
    setTopic("");
    setParentId("");
  }
  function openCreate(parent: string | null = null, type: "text" | "voice" | "category" = "text") {
    setSelection({ kind: "create", parentId: parent, type });
    setCreateType(type);
    setName("");
    setTopic("");
    setParentId(parent ?? "");
  }

  function enterBulkSelection(channelId: string) {
    if (!channels.find(c => c.id === channelId)) return;
    setSelection(null);
    setBulkSelectedIds([channelId]);
    setBulkPermissionDraft({ ...EMPTY_BULK_DRAFT });
    setPermissionTargetId(permissionPreviewRoleId);
    setPressingChannelId(null);
    suppressClickUntilRef.current = Date.now() + 700;
  }
  function exitBulkSelection() {
    setBulkSelectedIds([]);
    setBulkPermissionDraft({ ...EMPTY_BULK_DRAFT });
    setBulkSavingProgress(null);
    setBulkApplyLog({ kind: "idle", message: "一括反映の結果がここに表示されます" });
  }
  function toggleBulkChannel(channelId: string) {
    setBulkSelectedIds(current => {
      if (current.includes(channelId)) {
        const next = current.filter(id => id !== channelId);
        if (next.length === 0) { setBulkPermissionDraft({ ...EMPTY_BULK_DRAFT }); setBulkSavingProgress(null); }
        return next;
      }
      return [...current, channelId];
    });
  }

  async function saveBulkPermissions() {
    if (!bulkSelectedChannels.length) return;
    const hasChange = Object.values(bulkPermissionDraft).some(mode => mode !== "keep");
    if (!hasChange) { onNotice("変更する権限を選択してください"); return; }
    const targetId = permissionTargetId;
    const targetName = targetId === guildId ? "@everyone" : roles.find(r => r.id === targetId) ? `@${roles.find(r => r.id === targetId)!.name}` : permissionPreviewRoleName;
    const permissions: Partial<Record<PermissionKey, PermissionMode>> = {};
    for (const [rawKey, mode] of Object.entries(bulkPermissionDraft)) {
      if (mode === "keep") continue;
      permissions[rawKey as PermissionKey] = mode;
    }
    const changedLabels = Object.entries(bulkPermissionDraft).filter(([, mode]) => mode !== "keep").map(([key, mode]) => {
      const label = [...TEXT_PRIMARY_ROWS, ...TEXT_ADVANCED_ROWS, ...VOICE_PRIMARY_ROWS, ...VOICE_ADVANCED_ROWS].find(row => row.key === key)?.label ?? key;
      return `${label}=${mode === "inherit" ? "継承" : mode === "allow" ? "許可" : "拒否"}`;
    });
    setSaving(true);
    setBulkSavingProgress({ done: 0, total: bulkSelectedChannels.length });
    setBulkApplyLog({ kind: "saving", message: `${bulkSelectedChannels.length}チャンネルへ反映中…`, detail: `${targetName} / ${changedLabels.join("・")}` });
    try {
      const result = await api<{ ok: boolean; requested: number; updatedIds: string[]; failed: Array<{ id: string; name: string; message: string }> }>(
        `/api/guilds/${guildId}/channels/permissions/bulk`,
        { method: "PATCH", body: JSON.stringify({ channelIds: bulkSelectedChannels.map(c => c.id), targetId, permissions }) },
      );
      setBulkSavingProgress({ done: bulkSelectedChannels.length, total: bulkSelectedChannels.length });
      await load();
      if (result.failed.length > 0) {
        const details = result.failed.slice(0, 3).map(f => `#${f.name}: ${f.message}`).join(" / ");
        const rest = result.failed.length > 3 ? ` / ほか${result.failed.length - 3}件` : "";
        setBulkApplyLog({ kind: "error", message: `${result.updatedIds.length}/${bulkSelectedChannels.length}件反映・${result.failed.length}件失敗`, detail: `${targetName} / ${changedLabels.join("・")}` });
        throw new Error(`${result.failed.length}チャンネルで権限を反映できませんでした。 ${details}${rest}`);
      }
      setBulkPermissionDraft({ ...EMPTY_BULK_DRAFT });
      setBulkApplyLog({ kind: "success", message: `完了しました：${result.updatedIds.length}/${bulkSelectedChannels.length}チャンネル反映済み`, detail: `${targetName} / ${changedLabels.join("・")}` });
      onNotice(`${bulkSelectedChannels.length}チャンネルの${targetName}権限を更新しました`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setBulkApplyLog(current => (current.kind === "error" ? current : { kind: "error", message: "一括反映に失敗しました", detail: message }));
      onError(reason);
    } finally {
      setSaving(false);
      setBulkSavingProgress(null);
    }
  }

  async function persistChannelPermissions(channel: EditorChannel, targetId: string, permissions: Record<PermissionKey, PermissionMode>) {
    await api(`/api/guilds/${guildId}/channels/${channel.id}/permissions/${targetId}`, { method: "PATCH", body: JSON.stringify({ permissions }) });
  }

  async function savePermissions() {
    if (!selectedChannel || permissionSaving) return;
    const channel = selectedChannel;
    const targetId = permissionTargetId;
    const targetName = targetId === guildId ? "@everyone" : roles.find(r => r.id === targetId) ? `@${roles.find(r => r.id === targetId)!.name}` : targetId;
    setPermissionSaving(true);
    setPermissionSaveFeedback({ kind: "saving", message: "Discordへ権限を反映中…", detail: `#${channel.name} / ${targetName}` });
    try {
      await persistChannelPermissions(channel, targetId, { ...permissionDraft });
      setPermissionSaveFeedback({ kind: "success", message: "成功しました：権限を保存しました", detail: `#${channel.name} / ${targetName}` });
      onNotice("チャンネル権限を保存しました");
      await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setPermissionSaveFeedback({ kind: "error", message: "権限の保存に失敗しました", detail: message });
      onError(reason);
    } finally {
      setPermissionSaving(false);
    }
  }

  function renderPermissionBadge(channel: EditorChannel) {
    if (!showPermissionBadges) return null;
    const key: PermissionKey = isVoiceType(channel.type) ? "speak" : "send";
    const mode = permissionMode(channel, permissionPreviewRoleId, key);
    const label = mode === "allow" ? "発言 可" : mode === "deny" ? "発言 不可" : "発言 継承";
    return (
      <span className={`permission-badge ${mode}`} title={`${permissionPreviewRoleName}: ${label}`}>
        <span className="permission-badge-role">{permissionPreviewRoleName}</span>
        <span className="permission-badge-state">{label}</span>
      </span>
    );
  }

  async function saveExisting(event: FormEvent) {
    event.preventDefault();
    if (!selection || selection.kind === "create" || !name.trim()) return;
    const channel = selectedChannel;
    const targetId = permissionTargetId;
    const baselineDraft = channel ? draftFor(channel, targetId) : null;
    const permissionChanged = channel !== null && baselineDraft !== null && (Object.keys(permissionDraft) as PermissionKey[]).some(key => permissionDraft[key] !== baselineDraft[key]);
    const metadataChanged = selection.kind === "category"
      ? name.trim() !== selectedCategory?.name
      : channel !== null && (name.trim() !== channel.name || (parentId || null) !== (channel.parent_id || null));
    setSaving(true);
    if (permissionChanged && channel) {
      setPermissionSaveFeedback({ kind: "saving", message: "Discordへ権限を反映中…" });
    }
    try {
      if (permissionChanged && channel) {
        await persistChannelPermissions(channel, targetId, { ...permissionDraft });
        setPermissionSaveFeedback({ kind: "success", message: "成功しました：権限を保存しました" });
      }
      if (metadataChanged) {
        const body = selection.kind === "category" ? { name: name.trim() } : { name: name.trim(), parentId: parentId || null };
        await api(`/api/guilds/${guildId}/channels/${selection.id}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      if (permissionChanged || metadataChanged) await load();
      if (permissionChanged && metadataChanged) onNotice("チャンネル設定とロール権限を更新しました");
      else if (permissionChanged) onNotice("チャンネル権限を保存しました");
      else if (metadataChanged) onNotice(selection.kind === "category" ? "カテゴリを更新しました" : "チャンネルを更新しました");
      else onNotice("変更はありません");
    } catch (reason) {
      if (permissionChanged) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setPermissionSaveFeedback(current => (current.kind === "success" ? current : { kind: "error", message: "権限の保存に失敗しました", detail: message }));
      }
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createItem(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api(`/api/guilds/${guildId}/channels`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), type: createType, parentId: createType === "category" ? undefined : (parentId || undefined), topic: createType === "text" ? topic : undefined }),
      });
      await load();
      setSelection(null);
      setName(""); setTopic(""); setParentId("");
      onNotice(createType === "category" ? "カテゴリを追加しました" : "チャンネルを追加しました");
    } catch (reason) { onError(reason); } finally { setSaving(false); }
  }

  async function deleteSelected() {
    if (!selection || selection.kind === "create") return;
    const label = selection.kind === "category" ? "カテゴリ" : "チャンネル";
    if (!window.confirm(`${label}「${name}」を削除しますか？`)) return;
    setSaving(true);
    try {
      await api(`/api/guilds/${guildId}/channels/${selection.id}`, { method: "DELETE" });
      setSelection(null);
      await load();
      onNotice(`${label}を削除しました`);
    } catch (reason) { onError(reason); } finally { setSaving(false); }
  }

  async function reorderChannelTo(id: string, destination: { targetId: string; placement: "before" | "after" } | { parentId: string | null; placement: "start" }) {
    setSaving(true);
    setReorderFeedback({ kind: "saving", message: "Discordへ並び順を反映中…" });
    try {
      await api(`/api/guilds/${guildId}/channels/reorder`, { method: "PATCH", body: JSON.stringify({ id, ...destination }) });
      await load();
      setReorderFeedback({ kind: "success", message: "並び替えを反映しました" });
      window.setTimeout(() => setReorderFeedback(current => (current?.kind === "success" ? null : current)), 1800);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setReorderFeedback({ kind: "error", message: "並び替えに失敗しました: " + message });
      onError(reason);
    } finally { setSaving(false); setDragging(null); }
  }
  async function reorderCategoryTo(id: string, position: number) {
    setSaving(true);
    setReorderFeedback({ kind: "saving", message: "カテゴリの並び順を反映中…" });
    try {
      await api(`/api/guilds/${guildId}/channels/reorder`, { method: "PATCH", body: JSON.stringify({ id, position }) });
      await load();
      setReorderFeedback({ kind: "success", message: "カテゴリの並び替えを反映しました" });
      window.setTimeout(() => setReorderFeedback(current => (current?.kind === "success" ? null : current)), 1800);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setReorderFeedback({ kind: "error", message: "カテゴリの並び替えに失敗しました: " + message });
      onError(reason);
    } finally { setSaving(false); setDragging(null); }
  }
  function dropOnChannel(target: EditorChannel) {
    if (!dragging || dragging.kind !== "channel" || dragging.id === target.id) { setDragging(null); return; }
    void reorderChannelTo(dragging.id, { targetId: target.id, placement: "before" });
  }
  function dropOnCategory(target: EditorChannel) {
    if (!dragging) return;
    if (dragging.kind === "category") {
      if (dragging.id !== target.id) void reorderCategoryTo(dragging.id, target.position ?? 0);
      else setDragging(null);
      return;
    }
    void reorderChannelTo(dragging.id, { parentId: target.id, placement: "start" });
  }
  function dropUncategorized() {
    if (!dragging || dragging.kind !== "channel") { setDragging(null); return; }
    void reorderChannelTo(dragging.id, { parentId: null, placement: "start" });
  }

  // ── mobile long-press drag-and-drop ────────────────────────────────────────
  function clearPendingTouch() {
    const gesture = touchGestureRef.current;
    if (gesture) window.clearTimeout(gesture.timer);
    touchGestureRef.current = null;
    setPressingChannelId(null);
  }
  function beginTouchDrag(gesture: TouchGesture, touch: React.Touch) {
    const channel = channels.find(c => c.id === gesture.channelId);
    touchDraggingIdRef.current = gesture.channelId;
    setTouchDraggingId(gesture.channelId);
    setDragging({ kind: "channel", id: gesture.channelId });
    setTouchDragGhost({ channelId: gesture.channelId, name: channel?.name ?? "channel", type: channel?.type, width: gesture.width, height: gesture.height, x: touch.clientX - gesture.grabOffsetX, y: touch.clientY - gesture.grabOffsetY });
    setPressingChannelId(null);
    suppressClickUntilRef.current = Date.now() + 700;
    document.body.classList.add("cc-touch-reordering");
  }
  function startChannelLongPress(event: React.TouchEvent<HTMLButtonElement>, channelId: string) {
    if (event.touches.length !== 1 || saving) return;
    if (bulkMode) return;
    const touch = event.touches[0];
    const rect = event.currentTarget.getBoundingClientRect();
    clearPendingTouch();
    setPressingChannelId(channelId);
    const gesture: TouchGesture = {
      channelId, identifier: touch.identifier, startX: touch.clientX, startY: touch.clientY,
      grabOffsetX: touch.clientX - rect.left, grabOffsetY: touch.clientY - rect.top,
      width: rect.width, height: rect.height, armed: false,
      timer: window.setTimeout(() => {
        const g = touchGestureRef.current;
        if (!g || g.channelId !== channelId) return;
        g.armed = true;
        beginTouchDrag(g, touch);
      }, 420),
    };
    touchGestureRef.current = gesture;
  }
  function findTouchDropTarget(x: number, y: number): TouchDropTarget {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const channelEl = el.closest<HTMLElement>("[data-channel-id]");
    if (channelEl) {
      const id = channelEl.dataset.channelId!;
      if (id === touchDraggingIdRef.current) return null;
      const rect = channelEl.getBoundingClientRect();
      const placement: "before" | "after" = y < rect.top + rect.height / 2 ? "before" : "after";
      return { kind: "channel", id, placement };
    }
    const categoryEl = el.closest<HTMLElement>("[data-category-id]");
    if (categoryEl) return { kind: "category", id: categoryEl.dataset.categoryId! };
    const uncategorizedEl = el.closest<HTMLElement>("[data-uncategorized-drop]");
    if (uncategorizedEl) return { kind: "uncategorized" };
    return null;
  }
  function touchDropDescription(): string {
    const target = touchDropTargetRef.current;
    if (!target) return "指を離して並べ替え";
    if (target.kind === "uncategorized") return "カテゴリなしへ移動";
    if (target.kind === "category") {
      const category = channels.find(c => c.id === target.id);
      return `「${category?.name ?? ""}」の先頭へ移動`;
    }
    const channel = channels.find(c => c.id === target.id);
    return `「${channel?.name ?? ""}」の${target.placement === "before" ? "前" : "後"}へ移動`;
  }
  function trackPendingLongPress(event: React.TouchEvent<HTMLButtonElement>) {
    const gesture = touchGestureRef.current;
    const touch = Array.from(event.touches).find(t => t.identifier === gesture?.identifier);
    if (!gesture || !touch) return;
    if (!gesture.armed) {
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (Math.hypot(dx, dy) > 10) clearPendingTouch();
      return;
    }
    event.preventDefault();
    setTouchDragGhost(current => (current ? { ...current, x: touch.clientX - gesture.grabOffsetX, y: touch.clientY - gesture.grabOffsetY } : current));
    const target = findTouchDropTarget(touch.clientX, touch.clientY);
    touchDropTargetRef.current = target;
    setTouchDropTarget(target);
  }
  function endPendingLongPress() {
    const gesture = touchGestureRef.current;
    const wasArmed = gesture?.armed ?? false;
    const channelId = gesture?.channelId ?? null;
    clearPendingTouch();
    document.body.classList.remove("cc-touch-reordering");
    if (!wasArmed || !channelId) return;
    const target = touchDropTargetRef.current;
    touchDraggingIdRef.current = null;
    setTouchDraggingId(null);
    setTouchDragGhost(null);
    touchDropTargetRef.current = null;
    setTouchDropTarget(null);
    setDragging(null);
    if (!target) return;
    if (target.kind === "uncategorized") void reorderChannelTo(channelId, { parentId: null, placement: "start" });
    else if (target.kind === "category") void reorderChannelTo(channelId, { parentId: target.id, placement: "start" });
    else if (target.id !== channelId) void reorderChannelTo(channelId, { targetId: target.id, placement: target.placement });
  }

  return (
    <>
      {notice && <div className="alert success">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <section className="card server-editor-card">
        <div className="section-head server-editor-heading">
          <div>
            <span className="eyebrow">LIVE SERVER EDITOR</span>
            <h2>サーバー構成をプレビュー編集</h2>
            <p className="muted">左のDiscord風プレビューから追加・編集・削除できます。スマホではチャンネルを長押しして並べ替えできます。</p>
          </div>
          <div className="editor-heading-actions">
            <div className="permission-preview-controls">
              <label className="permission-preview-toggle">
                <input type="checkbox" checked={showPermissionBadges} onChange={e => { setShowPermissionBadges(e.target.checked); localStorage.setItem("cc_show_permission_badges", e.target.checked ? "1" : "0"); }} />
                <span>発言権を表示</span>
              </label>
              {showPermissionBadges && (
                <label className="permission-preview-role-select">
                  <span>対象</span>
                  <select
                    value={permissionPreviewRoleId}
                    onChange={e => {
                      const roleId = e.target.value;
                      setPermissionPreviewRoleId(roleId);
                      setPermissionTargetId(roleId);
                      if (selectedChannel) setPermissionDraft(draftFor(selectedChannel, roleId));
                      if (bulkMode) setBulkPermissionDraft({ ...EMPTY_BULK_DRAFT });
                      localStorage.setItem(`cc_permission_preview_role_${guildId}`, roleId);
                    }}
                  >
                    <option value={guildId}>@everyone</option>
                    {roles.filter(r => r.id !== guildId).map(role => <option key={role.id} value={role.id}>@{role.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <button className="secondary editor-add-category" onClick={() => openCreate(null, "category")}>＋ カテゴリ</button>
          </div>
        </div>

        <div className="server-editor-layout">
          <div className="discord-preview">
            {(touchDraggingId || reorderFeedback) && (
              <div className={touchDraggingId ? "reorder-status dragging" : `reorder-status ${reorderFeedback?.kind ?? ""}`} role="status" aria-live="polite">
                <span className="reorder-status-icon">{touchDraggingId ? "↕" : reorderFeedback?.kind === "success" ? "✓" : reorderFeedback?.kind === "error" ? "!" : "…"}</span>
                <strong>{touchDraggingId ? touchDropDescription() : reorderFeedback?.message}</strong>
              </div>
            )}
            <div
              className={`discord-preview-server ${touchDropTarget?.kind === "uncategorized" ? "touch-drop-target" : ""}`}
              data-uncategorized-drop="true"
              onDragOver={e => e.preventDefault()}
              onDrop={dropUncategorized}
            >
              <strong>{guildName}</strong>
              <button className="discord-plus" onClick={() => openCreate(null, "text")} title="チャンネルを追加" aria-label="チャンネルを追加">＋</button>
            </div>
            {showPermissionBadges && (
              <div className="permission-preview-context">
                <span className="permission-preview-context-icon">◉</span>
                <span>発言権表示</span>
                <strong>{permissionPreviewRoleName}</strong>
              </div>
            )}
            {bulkMode && (
              <div className="bulk-selection-bar">
                <div>
                  <strong>{bulkSelectedIds.length}チャンネル選択中</strong>
                  <span>{permissionPreviewRoleName} の権限を一括編集</span>
                </div>
                <button type="button" onClick={exitBulkSelection}>完了</button>
              </div>
            )}
            <div className="discord-channel-scroll" ref={channelScrollRef}>
              {touchDraggingId && (
                <div className={`uncategorized-touch-drop ${touchDropTarget?.kind === "uncategorized" ? "active" : ""}`} data-uncategorized-drop="true">
                  カテゴリなしへ移動
                </div>
              )}
              {uncategorized.length > 0 && (
                <div className="discord-channel-group uncategorized-group">
                  {uncategorized.map(channel => (
                    <button
                      key={channel.id}
                      data-channel-id={channel.id}
                      draggable={!bulkMode}
                      onDragStart={() => setDragging({ kind: "channel", id: channel.id })}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => dropOnChannel(channel)}
                      onTouchStart={e => startChannelLongPress(e, channel.id)}
                      onTouchMove={trackPendingLongPress}
                      onTouchEnd={endPendingLongPress}
                      onTouchCancel={endPendingLongPress}
                      onContextMenu={e => e.preventDefault()}
                      className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${bulkMode ? "bulk-mode" : ""} ${bulkSelectedIds.includes(channel.id) ? "bulk-selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""} ${pressingChannelId === channel.id ? "long-pressing" : ""} ${touchDraggingId === channel.id ? "touch-dragging" : ""} ${touchDropTarget?.kind === "channel" && touchDropTarget.id === channel.id ? `touch-drop-${touchDropTarget.placement}` : ""}`}
                      onClick={() => {
                        if (Date.now() < suppressClickUntilRef.current) return;
                        if (bulkMode) { toggleBulkChannel(channel.id); return; }
                        openChannel(channel.id);
                      }}
                      onDoubleClick={() => { if (!bulkMode) enterBulkSelection(channel.id); }}
                    >
                      <span className="channel-hash">{channelIcon(channel.type)}</span>
                      <span className="channel-name">{channel.name}</span>
                      {renderPermissionBadge(channel)}
                      {bulkMode ? (
                        <span className={`bulk-select-indicator ${bulkSelectedIds.includes(channel.id) ? "selected" : ""}`}>{bulkSelectedIds.includes(channel.id) ? "✓" : "○"}</span>
                      ) : (
                        <span className="channel-edit">›</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {categories.map(category => {
                const children = childrenOf(category.id);
                const selected = selection?.kind === "category" && selection.id === category.id;
                return (
                  <div
                    className={`discord-channel-group ${touchDropTarget?.kind === "category" && touchDropTarget.id === category.id ? "touch-category-target" : ""}`}
                    key={category.id}
                    data-category-id={category.id}
                  >
                    <div
                      className={`discord-category ${selected ? "selected" : ""} ${dragging?.kind === "category" && dragging.id === category.id ? "dragging" : ""}`}
                      draggable
                      onDragStart={() => setDragging({ kind: "category", id: category.id })}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => dropOnCategory(category)}
                    >
                      <button className="discord-category-name" onClick={() => openCategory(category.id)}>
                        <span>⌄</span>
                        <strong>{category.name.toUpperCase()}</strong>
                      </button>
                      <button className="discord-plus category-plus" onClick={() => openCreate(category.id, "text")} title={`${category.name} にチャンネルを追加`} aria-label={`${category.name} にチャンネルを追加`}>＋</button>
                    </div>
                    {children.map(channel => (
                      <button
                        key={channel.id}
                        data-channel-id={channel.id}
                        draggable={!bulkMode}
                        onDragStart={e => { e.stopPropagation(); setDragging({ kind: "channel", id: channel.id }); }}
                        onDragEnd={() => setDragging(null)}
                        onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                        onDrop={e => { e.stopPropagation(); dropOnChannel(channel); }}
                        onTouchStart={e => startChannelLongPress(e, channel.id)}
                        onTouchMove={trackPendingLongPress}
                        onTouchEnd={endPendingLongPress}
                        onTouchCancel={endPendingLongPress}
                        onContextMenu={e => e.preventDefault()}
                        className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${bulkMode ? "bulk-mode" : ""} ${bulkSelectedIds.includes(channel.id) ? "bulk-selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""} ${pressingChannelId === channel.id ? "long-pressing" : ""} ${touchDraggingId === channel.id ? "touch-dragging" : ""} ${touchDropTarget?.kind === "channel" && touchDropTarget.id === channel.id ? `touch-drop-${touchDropTarget.placement}` : ""}`}
                        onClick={() => {
                          if (Date.now() < suppressClickUntilRef.current) return;
                          if (bulkMode) { toggleBulkChannel(channel.id); return; }
                          openChannel(channel.id);
                        }}
                        onDoubleClick={() => { if (!bulkMode) enterBulkSelection(channel.id); }}
                      >
                        <span className="channel-hash">{channelIcon(channel.type)}</span>
                        <span className="channel-name">{channel.name}</span>
                        {renderPermissionBadge(channel)}
                        {bulkMode ? (
                          <span className={`bulk-select-indicator ${bulkSelectedIds.includes(channel.id) ? "selected" : ""}`}>{bulkSelectedIds.includes(channel.id) ? "✓" : "○"}</span>
                        ) : (
                          <span className="channel-edit">›</span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
              {categories.length === 0 && uncategorized.length === 0 && (
                <div className="discord-empty">
                  <span>まだチャンネルがありません</span>
                  <button onClick={() => openCreate(null, "category")}>最初のカテゴリを作る</button>
                </div>
              )}
            </div>
          </div>

          <div className="server-editor-inspector">
            {bulkMode && (
              <div className="bulk-permission-editor">
                <div className="editor-inspector-title">
                  <div>
                    <span className="eyebrow">BULK PERMISSIONS</span>
                    <h3>チャンネル権限を一括編集</h3>
                    <p>{bulkSelectedIds.length}チャンネルを選択中。変更した項目だけまとめて反映します。ダブルクリックでチャンネルを追加/解除できます。</p>
                  </div>
                  <button type="button" className="editor-close" onClick={exitBulkSelection} aria-label="一括選択を終了">×</button>
                </div>
                <div className="bulk-selected-channels">
                  {bulkSelectedChannels.map(channel => (
                    <button type="button" key={channel.id} onClick={() => toggleBulkChannel(channel.id)} title="選択解除">
                      <span>{channelIcon(channel.type)}</span>
                      <strong>{channel.name}</strong>
                      <i>×</i>
                    </button>
                  ))}
                </div>
                <div className="channel-permission-editor bulk-channel-permission-editor">
                  <div className="permission-editor-head">
                    <div><strong>対象ロール</strong><small>発言権プレビューと同じロールを使用します</small></div>
                  </div>
                  <label>
                    <span>対象ロール</span>
                    <select
                      value={permissionTargetId}
                      onChange={e => { const roleId = e.target.value; setPermissionTargetId(roleId); setPermissionPreviewRoleId(roleId); setBulkPermissionDraft({ ...EMPTY_BULK_DRAFT }); localStorage.setItem(`cc_permission_preview_role_${guildId}`, roleId); }}
                    >
                      <option value={guildId}>@everyone</option>
                      {roles.filter(r => r.id !== guildId).map(role => <option key={role.id} value={role.id}>@{role.name}</option>)}
                    </select>
                  </label>
                  <div className="bulk-permission-note"><strong>変更なし</strong> を選んだ権限は、各チャンネルの現在設定をそのまま残します。</div>
                  <div className="permission-list bulk-permission-list">{renderPermissionRows(bulkPermissionGroups.primary, true)}</div>
                  {bulkPermissionGroups.advanced.length > 0 && (
                    <details className="permission-advanced">
                      <summary><span>詳細な権限</span><small>管理・特殊用途の権限</small></summary>
                      <div className="permission-list bulk-permission-list">{renderPermissionRows(bulkPermissionGroups.advanced, true)}</div>
                    </details>
                  )}
                  <button type="button" className="primary permission-save bulk-permission-save" disabled={saving} onClick={() => void saveBulkPermissions()}>
                    {bulkSavingProgress ? `反映中… ${bulkSavingProgress.done}/${bulkSavingProgress.total}` : `${bulkSelectedIds.length}チャンネルへ一括反映`}
                  </button>
                  <div className={`bulk-apply-log ${bulkApplyLog.kind}`} role="status" aria-live="polite">
                    <div className="bulk-apply-log-title">
                      <span>{bulkApplyLog.kind === "saving" ? "⏳" : bulkApplyLog.kind === "success" ? "✓" : bulkApplyLog.kind === "error" ? "!" : "i"}</span>
                      <strong>{bulkApplyLog.message}</strong>
                    </div>
                    {bulkApplyLog.detail && <small>{bulkApplyLog.detail}</small>}
                  </div>
                </div>
              </div>
            )}

            {!selection && !bulkMode && (
              <div className="editor-welcome">
                <div className="editor-welcome-icon">＋</div>
                <h3>プレビューから編集</h3>
                <p>カテゴリ横の＋でその中にチャンネルを追加。チャンネル名を押すと、名前・カテゴリ・権限を変更できます。ダブルクリックで複数チャンネルを選んで権限を一括編集できます。スマホは長押しして並べ替えできます。</p>
                <div className="editor-quick-actions">
                  <button className="primary" onClick={() => openCreate(null, "text")}>＋ チャンネル</button>
                  <button className="secondary" onClick={() => openCreate(null, "category")}>＋ カテゴリ</button>
                </div>
              </div>
            )}

            {!bulkMode && selection?.kind === "create" && (
              <form className="editor-form" onSubmit={e => void createItem(e)}>
                <div className="editor-inspector-title">
                  <div><span className="eyebrow">ADD</span><h3>新しく追加</h3></div>
                  <button type="button" className="editor-close" onClick={() => setSelection(null)}>×</button>
                </div>
                <label>
                  <span>種類</span>
                  <select value={createType} onChange={e => { const next = e.target.value as typeof createType; setCreateType(next); if (next === "category") setParentId(""); }}>
                    <option value="text"># テキストチャンネル</option>
                    <option value="voice">🔊 ボイスチャンネル</option>
                    <option value="category">カテゴリ</option>
                  </select>
                </label>
                <label>
                  <span>名前</span>
                  <input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder={createType === "category" ? "INFORMATION" : "general"} />
                </label>
                {createType !== "category" && (
                  <>
                    <label>
                      <span>カテゴリ</span>
                      <select value={parentId} onChange={e => setParentId(e.target.value)}>
                        <option value="">カテゴリなし</option>
                        {categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
                      </select>
                    </label>
                    {createType === "text" && (
                      <label>
                        <span>トピック</span>
                        <textarea value={topic} onChange={e => setTopic(e.target.value)} maxLength={1024} placeholder="任意" />
                      </label>
                    )}
                  </>
                )}
                <button className="primary editor-save" type="submit" disabled={saving}>{saving ? "作成中…" : "追加する"}</button>
              </form>
            )}

            {!bulkMode && (selectedChannel || selectedCategory) && selection?.kind !== "create" && (
              <form className="editor-form" onSubmit={e => void saveExisting(e)}>
                <div className="editor-inspector-title">
                  <div><span className="eyebrow">EDIT</span><h3>{selectedCategory ? "カテゴリを編集" : "チャンネルを編集"}</h3></div>
                  <button type="button" className="editor-close" onClick={() => setSelection(null)}>×</button>
                </div>
                <label>
                  <span>名前</span>
                  <input required maxLength={100} value={name} onChange={e => setName(e.target.value)} />
                </label>
                {selectedChannel && (
                  <>
                    <label>
                      <span>所属カテゴリ</span>
                      <select value={parentId} onChange={e => setParentId(e.target.value)}>
                        <option value="">カテゴリなし</option>
                        {categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
                      </select>
                    </label>
                    <div className="channel-permission-editor">
                      <div className="permission-editor-head">
                        <div><strong>チャンネル権限</strong><small>ロールごとに継承 / 許可 / 拒否を設定</small></div>
                      </div>
                      <label>
                        <span>対象ロール</span>
                        <select
                          value={permissionTargetId}
                          onChange={e => {
                            const targetId = e.target.value;
                            setPermissionTargetId(targetId);
                            setPermissionPreviewRoleId(targetId);
                            setPermissionDraft(draftFor(selectedChannel, targetId));
                            setPermissionSaveFeedback({ kind: "idle", message: "権限を変更して「権限を保存」を押してください" });
                            localStorage.setItem(`cc_permission_preview_role_${guildId}`, targetId);
                          }}
                        >
                          <option value={guildId}>@everyone</option>
                          {roles.filter(r => r.id !== guildId).map(role => <option key={role.id} value={role.id}>@{role.name}</option>)}
                        </select>
                      </label>
                      <div className="permission-list">{renderPermissionRows(selectedPermissionGroups.primary)}</div>
                      {selectedPermissionGroups.advanced.length > 0 && (
                        <details className="permission-advanced">
                          <summary><span>詳細な権限</span><small>管理・特殊用途の権限</small></summary>
                          <div className="permission-list">{renderPermissionRows(selectedPermissionGroups.advanced)}</div>
                        </details>
                      )}
                      <button type="button" className="secondary permission-save" disabled={saving || permissionSaving} onClick={() => void savePermissions()}>
                        {permissionSaving ? "反映中…" : "権限を保存"}
                      </button>
                      <div className={`bulk-apply-log ${permissionSaveFeedback.kind}`} role="status" aria-live="polite">
                        <div className="bulk-apply-log-title">
                          <span>{permissionSaveFeedback.kind === "saving" ? "⏳" : permissionSaveFeedback.kind === "success" ? "✓" : permissionSaveFeedback.kind === "error" ? "!" : "i"}</span>
                          <strong>{permissionSaveFeedback.message}</strong>
                        </div>
                        {permissionSaveFeedback.detail && <small>{permissionSaveFeedback.detail}</small>}
                      </div>
                    </div>
                  </>
                )}
                <div className="editor-action-row">
                  <button className="primary" type="submit" disabled={saving}>{saving ? "保存中…" : "すべての変更を保存"}</button>
                  <button className="danger" type="button" disabled={saving} onClick={() => void deleteSelected()}>削除</button>
                </div>
              </form>
            )}
          </div>
        </div>
      </section>

      {touchDragGhost && (
        <div
          className="touch-channel-ghost"
          style={{ width: touchDragGhost.width, height: touchDragGhost.height, transform: `translate3d(${touchDragGhost.x}px, ${touchDragGhost.y}px, 0) scale(1.025)` }}
          aria-hidden="true"
        >
          <span className="channel-hash">{channelIcon(touchDragGhost.type ?? 0)}</span>
          <span className="channel-name">{touchDragGhost.name}</span>
          <span className="touch-ghost-grip">⋮⋮</span>
        </div>
      )}

      <RoleManagerSection guildId={guildId} roles={roles} onReload={load} flash={flash} fail={fail} />
    </>
  );
}

function RoleManagerSection({ guildId, roles, onReload, flash, fail }: { guildId: string; roles: EditorRole[]; onReload: () => Promise<void>; flash: (m: string) => void; fail: (r: unknown) => void }) {
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [roleCreating, setRoleCreating] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [roleColor, setRoleColor] = useState(0);
  const [roleColorHexInput, setRoleColorHexInput] = useState("#000000");
  const [rolePermissions, setRolePermissions] = useState(0n);
  const [roleSaving, setRoleSaving] = useState(false);

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
        await api(`/api/guilds/${guildId}/roles`, { method: "POST", body: JSON.stringify({ name, color: roleColor, permissions: rolePermissions.toString() }) });
        await onReload();
        flash("ロールを追加しました");
      } else if (selectedRole) {
        const payload = selectedRole.isEveryone ? { permissions: rolePermissions.toString() } : { name, color: roleColor, permissions: rolePermissions.toString() };
        await api(`/api/guilds/${guildId}/roles/${selectedRole.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        await onReload();
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
      await onReload();
      flash("ロールを削除しました");
    } catch (reason) { fail(reason); } finally { setRoleSaving(false); }
  }

  return (
    <section className="card role-manager-card">
      <div className="section-head role-manager-heading">
        <div>
          <span className="eyebrow">ROLE MANAGER</span>
          <h2>ロール管理</h2>
          <p className="muted">ロールの追加・削除・色変更と、サーバー全体の権限を設定できます。</p>
        </div>
        <button type="button" className="primary" onClick={startCreateRole} disabled={roleSaving}>＋ ロール追加</button>
      </div>

      <div className="role-manager-layout">
        <div className="role-manager-list">
          {roles.map(role => (
            <button type="button" key={role.id} className={!roleCreating && selectedRoleId === role.id ? "role-manager-item active" : "role-manager-item"} onClick={() => loadRole(role)}>
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
              <button type="button" className="danger" disabled={roleSaving} onClick={() => void deleteRole()}>削除</button>
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
                      <input className="role-color-input" type="color" value={roleColorHex(roleColor)} onChange={e => { setRoleColorHexInput(e.target.value); setRoleColor(parseInt(e.target.value.slice(1), 16)); }} />
                      <input className="role-hex-input" value={roleColorHexInput} onChange={e => applyRoleColorHex(e.target.value)} maxLength={7} spellCheck={false} />
                      <button type="button" className="secondary" onClick={() => { setRoleColor(0); setRoleColorHexInput("#000000"); }}>既定色</button>
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
                <div className="role-admin-warning">Administrator はチャンネル個別設定を含む全権限を実質的に許可します。</div>
              )}

              <button className="primary role-save-button" type="submit" disabled={roleSaving}>
                {roleSaving ? "保存中…" : roleCreating ? "ロールを追加" : "変更を保存"}
              </button>
            </>
          )}
        </form>
      </div>
    </section>
  );
}
